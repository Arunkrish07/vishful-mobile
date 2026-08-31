/**
 * TenantLifecycleScreen.tsx
 * Full lifecycle: Booking → Onboarding → Stay → Notice → Exit
 * Tabs: Visual Map | Booking | Onboarding | Switching | Notices | Exit | Refunds | Not in Property
 * Bed Status KPI is always visible (web parity — not a separate Dashboard tab).
 *
 * ► Data layer : Convex actions → Supabase (existing tables/columns only)
 * ► No direct DB access in this file
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal,
  TextInput, Alert, ActivityIndicator, FlatList, RefreshControl,
  Dimensions, KeyboardAvoidingView, Platform, Image, Animated,
} from 'react-native';
import { CONVEX_SITE_URL } from '../lib/config';
import { useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useAuth } from '../lib/auth';
import { spacing, fontSize, borderRadius } from '../lib/theme';
import { LoadingScreen, DateField } from '../components/shared';
import { formatDate } from '../lib/dateUtils';
import { useMountedRef, isAbortError } from '../lib/safeAsync';
import { client, api } from '../lib/convexApi';
import { uploadKycPhoto, uploadPaymentProof, extractPaymentProof } from '../services/ticketService';
import * as sb from '../lib/supabaseService';
// (registration PDF helpers are defined inline below — no separate module)


// ═══ Inlined Registration PDF module (was lib/registrationPdf.ts) ═══
interface RegistrationPdfData {
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
interface TermItem { id: string; text: string; subItems?: string[]; footnote?: string }
const TERMS_OF_STAY: TermItem[] = [
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

const PURPLE = '#2563EB';
const ORANGE = '#2563EB';

const regFmtAmt = (v: number | string | undefined): string => {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-IN');
};
const regEsc = (v: any): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const field = (label: string, value: string, opts?: { bold?: boolean }) => `
  <div class="field">
    <div class="flabel">${regEsc(label)}</div>
    <div class="fvalue${opts?.bold ? ' b' : ''}">${regEsc(value) || '&nbsp;'}</div>
  </div>`;

const amountRow = (label: string, amount: string, opts?: { bold?: boolean }) => `
  <div class="arow${opts?.bold ? ' b' : ''}">
    <div class="alabel">${regEsc(label)}</div>
    <div class="aval"><span class="rs">Rs.</span> ${regEsc(amount) || '0'}</div>
  </div>`;

const checkbox = (checked: boolean, label: string) => `
  <span class="cb">${checked ? '<span class="cbx">&#10003;</span>' : '<span class="cbx">&nbsp;</span>'} ${regEsc(label)}</span>`;

/** Build the registration HTML (2 pages). ticks marks the acknowledged terms. */
function buildRegistrationHtml(d: RegistrationPdfData, ticks: Record<string, boolean> = {}): string {
  const fullName = [d.firstName, d.lastName].filter(Boolean).join(' ');
  const bt = (d.bedType || '').toString();
  const tt = (d.toiletType || '').toString();

  const termsHtml = TERMS_OF_STAY.map((t, i) => `
    <div class="term">
      ${checkbox(!!ticks[t.id], '')}
      <div class="ttext">
        <span class="tn">${i + 1}.</span> ${regEsc(t.text)}
        ${t.subItems ? `<div class="subs">${t.subItems.map((s) => `<div class="sub">${regEsc(s)}</div>`).join('')}</div>` : ''}
        ${t.footnote ? `<div class="foot">${regEsc(t.footnote)}</div>` : ''}
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
    .arow.b { background: rgba(99,102,241,0.06); border-color: ${PURPLE}; }
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
          <div class="fvalue">${regEsc(d.address) || '&nbsp;'}</div>
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

      ${amountRow('Refundable Advance (1.5 Months)', regFmtAmt(d.refundableAdvance))}
      ${amountRow(`Rental Amount (Calculated from: ${d.calculatedFromDate || ''})`, regFmtAmt(d.rentalAmount))}

      <div class="vrow">
        <span style="font-weight:700;">Vehicle</span>
        ${checkbox(d.vehicleType === '2W', '2 Wheeler')}
        ${checkbox(d.vehicleType === '4W', '4 Wheeler')}
        <span style="color:#74747a;">Vehicle No:</span>
        <span style="font-weight:700;">${regEsc(d.vehicleNumber)}</span>
        <span style="margin-left:auto;color:#74747a;">Rs. <b>${regEsc(regFmtAmt(d.vehicleCharge)) || '0'}</b></span>
      </div>

      ${amountRow('On Boarding Charges', regFmtAmt(d.onBoardingCharges))}
      ${amountRow('CC Charges (1.5%)', regFmtAmt(d.ccCharges))}
      ${amountRow('Total Payment due', regFmtAmt(d.totalDue), { bold: true })}

      <div class="pdhdr">Payment Details</div>
      <div class="grid2">
        ${field('Payment Mode', d.paymentMode || d.paidVia || '')}
        ${field('Reference Number', d.referenceNumber || '')}
        ${field('Paid Amount', regFmtAmt(d.paidAmount))}
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
      <div class="ackline">By signing below, ${regEsc(fullName) || 'the tenant'} acknowledges all the above Terms of Stay.</div>
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
async function generateRegistrationPdf(
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
async function shareRegistrationPdf(uri: string): Promise<void> {
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

// ═══ end inlined Registration PDF module ═══

const { width: SW } = Dimensions.get('window');

// ─── Vishful brand palette (web screen-life tokens) ─────────────────────────
const VBRAND = {
  purple: '#6A2C90', purpleDeep: '#4E2069', purpleSoft: '#F3ECF9', orange: '#2563EB',
  ink900: '#0F172A', ink700: '#334155', ink600: '#556274', ink500: '#64748B', ink400: '#94A3B8',
  surface: '#FFFFFF', surfaceSoft: '#F8FAFC',
  cardBorder: '#EEF1F6', line: '#E2E8F0', softLine: '#EEF2F7', shadow: '#0F172A',
  occ: '#16A34A', book: '#1856FF', note: '#D97706', vac: '#E11D48', nb: '#64748B',
};

// Voice transcription runs server-side via POST /api/transcribe (no client key).
const TRANSCRIBE_URL = `${CONVEX_SITE_URL}/api/transcribe`;

// ─── helpers ─────────────────────────────────────────────────────────────────

const fmtAmt = (v: number | null | undefined) =>
  v == null ? '0' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.ceil(v));

const fmtDate = (d: string | null | undefined) => formatDate(d, '—');

const today = () => new Date().toISOString().split('T')[0];

const daysBetween = (a: string, b?: string) => {
  try {
    const d1 = new Date(a); const d2 = b ? new Date(b) : new Date();
    return Math.floor((d2.getTime() - d1.getTime()) / 86400000);
  } catch { return 0; }
};

const getDaysInMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CFG: Record<string, { color: string; bg: string; label: string; icon: string }> = {
  occupied:        { color: '#16A34A', bg: '#DCFCE7', label: 'Occupied',    icon: 'checkmark-circle'    },
  vacant:          { color: '#DC2626', bg: '#FEE2E2', label: 'Vacant',      icon: 'radio-button-off'    },
  notice:          { color: '#EA580C', bg: '#FFEDD5', label: 'Notice',      icon: 'warning'             },
  booked:          { color: '#1D4ED8', bg: '#EEF3FF', label: 'Booked',      icon: 'calendar'            },
  'notice-booked': { color: '#6A2C90', bg: '#EDE9FE', label: 'N+Booked',   icon: 'git-branch'          },
  Staying:         { color: '#16A34A', bg: '#DCFCE7', label: 'Staying',     icon: 'home'                },
  'On-Notice':     { color: '#EA580C', bg: '#FFEDD5', label: 'On Notice',   icon: 'warning'             },
  Booked:          { color: '#1D4ED8', bg: '#EEF3FF', label: 'Booked',      icon: 'calendar'            },
  Exited:          { color: '#DC2626', bg: '#FEE2E2', label: 'Exited',      icon: 'exit'                },
  New:             { color: '#1D4ED8', bg: '#EEF3FF', label: 'New',         icon: 'person-add'          },
  pending:         { color: '#EA580C', bg: '#FFEDD5', label: 'Pending',     icon: 'time'                },
  paid:            { color: '#16A34A', bg: '#DCFCE7', label: 'Paid',        icon: 'checkmark-circle'    },
  none:            { color: '#64748B', bg: '#F1F5F9', label: 'No Refund',   icon: 'remove-circle'       },
  completed:       { color: '#16A34A', bg: '#DCFCE7', label: 'Completed',   icon: 'checkmark-done'      },
};

const getStatus = (s: string) =>
  STATUS_CFG[s] ?? { color: '#556274', bg: '#F1F5F9', label: s, icon: 'ellipse-outline' };

// ─── TABS ────────────────────────────────────────────────────────────────────

/** Web Lifecycle modules (`ol`) — exact order/labels. Bed Status is not a tab. */
const TABS = [
  { key: 'map',      label: 'Visual Map',     icon: 'map-outline'             },
  { key: 'booking',  label: 'Booking',        icon: 'calendar-outline'        },
  { key: 'onboard',  label: 'Onboarding',     icon: 'person-add-outline'      },
  { key: 'switch',   label: 'Switching',      icon: 'swap-horizontal-outline' },
  { key: 'notices',  label: 'Notices',        icon: 'notifications-outline'   },
  { key: 'exit',     label: 'Exit',           icon: 'log-out-outline'         },
  { key: 'refunds',  label: 'Refunds',        icon: 'wallet-outline'          },
  { key: 'absent',   label: 'Not in Property', icon: 'home-outline'           },
];

const BED_FOCUS_TILES = [
  { key: 'occupied', label: 'Occupied', color: '#16A34A' },
  { key: 'booked',   label: 'Booked',   color: '#1856FF' },
  { key: 'notice',   label: 'Notice',   color: '#D97706' },
  { key: 'vacant',   label: 'Vacant',   color: '#E11D48' },
  { key: 'notbooked', label: 'Not Booked', color: '#64748B' },
] as const;

const PAY_MODES = [
  { label: 'Cash',          value: 'cash'          },
  { label: 'UPI',           value: 'upi'           },
  { label: 'RTGS',          value: 'rtgs'          },
  { label: 'Bank Transfer', value: 'bank_transfer'  },
  { label: 'Credit Card',   value: 'credit_card'   },
];

// Map an OCR-detected bank/app name to one of our PAY_MODES values.
// GPay / PhonePe / Paytm etc. are UPI apps → 'upi'.
function mapOcrPaymentMode(bankName?: string | null): string | null {
  if (!bankName) return null;
  const b = String(bankName).toLowerCase();
  if (/\b(g[\s-]?pay|google[\s-]?pay|phonepe|paytm|bhim|upi|cred|amazon[\s-]?pay|mobikwik|freecharge)\b/.test(b)) return 'upi';
  if (/\brtgs\b/.test(b)) return 'rtgs';
  if (/\b(card|visa|master|rupay|credit|debit)\b/.test(b)) return 'credit_card';
  if (/\bcash\b/.test(b)) return 'cash';
  // Any bank name (HDFC, SBI, ICICI, NEFT, IMPS, transfer…) → bank transfer.
  if (/\b(neft|imps|bank|transfer|hdfc|sbi|icici|axis|kotak|yes|idfc|pnb|bob|canara|union|indus)\b/.test(b)) return 'bank_transfer';
  return null;
}

// ─── Shared UI Components ─────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View style={[{
      backgroundColor: VBRAND.surface, borderRadius: 16,
      borderWidth: 1, borderColor: VBRAND.cardBorder,
      padding: 12, marginBottom: 10,
      shadowColor: VBRAND.shadow, shadowOpacity: 0.05, shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 }, elevation: 1,
    }, style]}>{children}</View>
  );
}

function SectionTitle({ title }: { title: string; accent?: string }) {
  return (
    <View style={{ marginBottom: 10, marginTop: 4 }}>
      <Text style={{ fontSize: 17, fontWeight: '800', color: VBRAND.ink900 }}>{title}</Text>
    </View>
  );
}

function LifeAvatar({ name, vacant }: { name?: string; vacant?: boolean }) {
  const initial = vacant ? 'V' : (name || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={{
      width: 30, height: 30, borderRadius: 15,
      backgroundColor: vacant ? '#FEE2E2' : VBRAND.purpleSoft,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text style={{ fontSize: 12, fontWeight: '800', color: vacant ? '#B91C1C' : VBRAND.purpleDeep }}>{initial}</Text>
    </View>
  );
}

function LifeTenantCard({
  name, sub, amount, amountOk, pill, vacant, onPress, right,
}: {
  name: string; sub?: string; amount?: string; amountOk?: boolean;
  pill?: string; vacant?: boolean; onPress?: () => void; right?: React.ReactNode;
}) {
  const body = (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 9,
      backgroundColor: '#fff', borderWidth: 1, borderColor: VBRAND.softLine,
      borderRadius: 12, paddingVertical: 9, paddingHorizontal: 10, marginBottom: 6,
      shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    }}>
      <LifeAvatar name={name} vacant={vacant} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: VBRAND.ink900 }} numberOfLines={1}>{name}</Text>
          {!!pill && (
            <View style={{
              backgroundColor: pill === 'On Notice' || pill === 'New' ? (pill === 'On Notice' ? '#FEF3C7' : VBRAND.purpleSoft) : VBRAND.purpleSoft,
              paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999,
            }}>
              <Text style={{
                fontSize: 10, fontWeight: '700',
                color: pill === 'On Notice' ? '#B45309' : VBRAND.purpleDeep,
              }}>{pill}</Text>
            </View>
          )}
        </View>
        {!!sub && <Text style={{ fontSize: 12, color: VBRAND.ink600, marginTop: 2 }} numberOfLines={1}>{sub}</Text>}
      </View>
      {amount != null && (
        <Text style={{ fontSize: 14, fontWeight: '700', color: amountOk ? '#15803D' : VBRAND.ink900 }}>{amount}</Text>
      )}
      {right}
    </View>
  );
  if (onPress) {
    return <TouchableOpacity activeOpacity={0.85} onPress={onPress}>{body}</TouchableOpacity>;
  }
  return body;
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
      <Text style={{ fontSize: 12, color: VBRAND.ink500, fontWeight: '500', flex: 1 }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '700', color: valueColor || VBRAND.ink900, maxWidth: '60%', textAlign: 'right', letterSpacing: -0.1 }}>{value}</Text>
    </View>
  );
}

function Divider() {
  return <View style={{ height: 0.5, backgroundColor: '#EEF2FF', marginVertical: 10 }} />;
}

function EmptyCard({ message }: { message: string }) {
  return (
    <Card style={{ alignItems: 'center', paddingVertical: 36 }}>
      <View style={{
        width: 56, height: 56, borderRadius: 18,
        backgroundColor: VBRAND.purpleSoft,
        alignItems: 'center', justifyContent: 'center', marginBottom: 12,
      }}>
        <Ionicons name="folder-open-outline" size={26} color={VBRAND.purple} />
      </View>
      <Text style={{ color: VBRAND.ink500, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>{message}</Text>
    </Card>
  );
}

function StatusPill({ status }: { status: string }) {
  const cfg = getStatus(status);
  return (
    <View style={{ backgroundColor: cfg.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
      flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: cfg.color }} />
      <Text style={{ fontSize: 10, fontWeight: '800', color: cfg.color, letterSpacing: 0.3 }}>{cfg.label}</Text>
    </View>
  );
}

function ActionBtn({ title, onPress, variant = 'primary', loading, icon, small, disabled }: {
  title: string; onPress: () => void;
  variant?: 'primary' | 'danger' | 'outline' | 'ghost';
  loading?: boolean; icon?: string; small?: boolean; disabled?: boolean;
}) {
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  const isOutline = variant === 'outline';
  const isGhost = variant === 'ghost';

  // Solid bg for outline/ghost/danger; gradient for primary
  const bg = isDanger ? '#DC2626' : isOutline ? 'transparent' : isGhost ? VBRAND.purpleSoft : VBRAND.purple;
  const tc = isOutline || isGhost ? VBRAND.purple : '#fff';
  const bw = isOutline ? 1.5 : 0;
  const height = small ? 36 : 48;
  const px = small ? 14 : 22;
  const fs = small ? 12 : 14;
  const iconSize = small ? 14 : 16;

  if (isPrimary && !loading && !disabled) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.88}
        style={{ borderRadius: 999, overflow: 'hidden',
          shadowColor: VBRAND.purple, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 5 }}>
        <LinearGradient
          colors={[VBRAND.purple, VBRAND.purpleDeep]}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={{ height, paddingHorizontal: px, flexDirection: 'row',
            alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          {icon ? <Ionicons name={icon as any} size={iconSize} color="#fff" /> : null}
          <Text style={{ fontSize: fs, fontWeight: '800', color: '#fff', letterSpacing: 0.2 }}>{title}</Text>
        </LinearGradient>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity onPress={onPress} disabled={loading || disabled} activeOpacity={0.85}
      style={{ backgroundColor: bg, borderRadius: 999, borderWidth: bw, borderColor: VBRAND.purple,
        height, paddingHorizontal: px,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
        opacity: (loading || disabled) ? 0.5 : 1,
        shadowColor: isDanger ? '#DC2626' : VBRAND.purple,
        shadowOpacity: isOutline || isGhost ? 0 : 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }}>
      {loading
        ? <ActivityIndicator size="small" color={tc} />
        : icon ? <Ionicons name={icon as any} size={iconSize} color={tc} /> : null}
      <Text style={{ fontSize: fs, fontWeight: '800', color: tc, letterSpacing: 0.2 }}>
        {loading ? 'Processing…' : title}
      </Text>
    </TouchableOpacity>
  );
}

// ─── BottomSheet ─────────────────────────────────────────────────────────────

function BottomSheet({ visible, onClose, title, children }: {
  visible: boolean; onClose: () => void; title: string; children: React.ReactNode;
}) {
  // Intercept Android hardware back — close sheet, do NOT navigate away
  React.useEffect(() => {
    if (!visible) return;
    const { BackHandler } = require('react-native');
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true; // true = event consumed, navigation stack untouched
    });
    return () => sub.remove();
  }, [visible, onClose]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => { /* blocked by navigation.beforeRemove */ }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* Backdrop — tap closes sheet, does NOT navigate */}
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} activeOpacity={1} onPress={onClose} />
        <View style={{
          backgroundColor: '#F8FAFC', borderTopLeftRadius: 32, borderTopRightRadius: 32,
          maxHeight: '92%', paddingBottom: 32,
          shadowColor: VBRAND.shadow, shadowOpacity: 0.2, shadowRadius: 20, shadowOffset: { width: 0, height: -6 },
        }}>
          {/* Drag handle */}
          <View style={{ alignItems: 'center', paddingTop: 10 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(106,44,144,0.2)' }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 22, paddingTop: 14, paddingBottom: 16,
            borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6' }}>
            <Text style={{ fontSize: 18, fontWeight: '900', color: VBRAND.ink900, letterSpacing: -0.3 }}>{title}</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
              style={{
                width: 34, height: 34, borderRadius: 12,
                backgroundColor: '#EEF2FF',
                alignItems: 'center', justifyContent: 'center',
              }}>
              <Ionicons name="close" size={18} color={VBRAND.purple} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 22, paddingBottom: 40 }}
            showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Form Helpers ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ fontSize: 10, fontWeight: '800', color: VBRAND.ink500, marginBottom: 7, letterSpacing: 1 }}>
        {label.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

function TextF({ value, onChange, placeholder, keyboardType, multiline, editable }: {
  value: string; onChange?: (v: string) => void; placeholder?: string;
  keyboardType?: any; multiline?: boolean; editable?: boolean;
}) {
  return (
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder || ''}
      placeholderTextColor={VBRAND.ink400} keyboardType={keyboardType || 'default'}
      multiline={multiline} editable={editable !== false}
      style={{
        backgroundColor: editable === false ? 'rgba(243,238,247,0.7)' : '#fff',
        borderRadius: 14, borderWidth: 0.5, borderColor: '#EEF1F6',
        paddingHorizontal: 14, paddingVertical: multiline ? 12 : 0,
        height: multiline ? 92 : 48, fontSize: 14, color: VBRAND.ink900, fontWeight: '500',
        shadowColor: VBRAND.shadow, shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
      }}
    />
  );
}

function SelectF({ options, value, onChange, placeholder }: {
  options: { label: string; value: string }[];
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(o => o.value === value);

  // Intercept Android back when dropdown is open — close dropdown, don't navigate
  React.useEffect(() => {
    if (!open) return;
    const { BackHandler } = require('react-native');
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open]);
  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} activeOpacity={0.85} style={{
        backgroundColor: '#fff', borderRadius: 14, borderWidth: 0.5,
        borderColor: '#EEF1F6', paddingHorizontal: 14, height: 48,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        shadowColor: VBRAND.shadow, shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
      }}>
        <Text style={{ fontSize: 14, color: selected ? VBRAND.ink900 : VBRAND.ink400, flex: 1, fontWeight: selected ? '600' : '500' }} numberOfLines={1}>
          {selected ? selected.label : (placeholder || 'Select…')}
        </Text>
        <View style={{
          width: 24, height: 24, borderRadius: 8,
          backgroundColor: VBRAND.purpleSoft,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name="chevron-down" size={14} color={VBRAND.purple} />
        </View>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 }}
          activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={{ backgroundColor: '#fff', borderRadius: 22, maxHeight: 460, overflow: 'hidden',
            shadowColor: VBRAND.shadow, shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: { width: 0, height: 10 } }}>
            <FlatList data={options} keyExtractor={o => o.value}
              renderItem={({ item }) => {
                const isActive = item.value === value;
                return (
                  <TouchableOpacity onPress={() => { onChange(item.value); setOpen(false); }}
                    style={{ paddingHorizontal: 18, paddingVertical: 14,
                      borderBottomWidth: 0.5, borderBottomColor: '#EEF1F6',
                      backgroundColor: isActive ? VBRAND.purpleSoft : '#fff',
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 14, color: VBRAND.ink900,
                      fontWeight: isActive ? '800' : '500' }}>{item.label}</Text>
                    {isActive && <Ionicons name="checkmark-circle" size={18} color={VBRAND.purple} />}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

// Simple date input (YYYY-MM-DD text field)
function DateF({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <View>
      {label && <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#556274', marginBottom: 6 }}>{label.toUpperCase()}</Text>}
      <DateField value={value} onChange={onChange} placeholder="Select date" />
    </View>
  );
}

// ─── MAIN SCREEN ─────────────────────────────────────────────────────────────

export default function TenantLifecycleScreen() {
  const { user } = useAuth();
  const mounted = useMountedRef();
  const navigation = useNavigation() as any;

  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [bedFocus, setBedFocus] = useState<string | null>('occupied');
  const [bedFocusSearch, setBedFocusSearch] = useState('');
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving]       = useState(false);

  // ── data ──
  const [allotments, setAllotments]   = useState<any[]>([]);
  const [tenants, setTenants]         = useState<any[]>([]);
  const [beds, setBeds]               = useState<any[]>([]);
  const [apartments, setApartments]   = useState<any[]>([]);
  const [properties, setProperties]   = useState<any[]>([]);
  const [exits, setExits]             = useState<any[]>([]);
  const [exitTasks, setExitTasks]     = useState<any[]>([]);
  const [notices, setNotices]         = useState<any[]>([]);
  const [receipts, setReceipts]       = useState<any[]>([]);
  const [bedRates, setBedRates]       = useState<any[]>([]);
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [absenceRecords, setAbsenceRecords] = useState<any[]>([]);
  const [config, setConfig]           = useState<any>({
    booking_fee: 1000, onboarding_fee: 1000, advance_ratio: 1.5,
    exit_fee_under_1yr: 2250, key_loss_fee: 500, notice_period_days: 30, refund_deadline_days: 5,
    cc_charge_percent: 1.5,
  });
  const [roomSwitches, setRoomSwitches] = useState<any[]>([]);

  // ── sheet visibility ──
  const [bookingOpen,       setBookingOpen]       = useState(false);
  const [onboardOpen,       setOnboardOpen]       = useState(false);
  // ── Registration PDF / preview ──
  const [regPreviewOpen,   setRegPreviewOpen]   = useState(false);
  const [regPdfUri,        setRegPdfUri]        = useState<string | null>(null);
  const [regData,          setRegData]          = useState<RegistrationPdfData | null>(null);
  const [regTicks,         setRegTicks]         = useState<Record<string, boolean>>({});
  const [regGenerating,    setRegGenerating]    = useState(false);
  const [regSendingWa,     setRegSendingWa]     = useState(false);
  const [switchOpen,        setSwitchOpen]        = useState(false);
  const [noticeOpen,        setNoticeOpen]        = useState(false);
  const [exitOpen,          setExitOpen]          = useState(false);

  // ── Voice Notice state ──
  const [voiceNoticeOpen,   setVoiceNoticeOpen]   = useState(false);
  const [noticeRecState,    setNoticeRecState]     = useState<'idle'|'recording'|'transcribing'|'done'|'error'>('idle');
  const [noticeTranscript,  setNoticeTranscript]  = useState('');
  const [noticeVoiceErr,    setNoticeVoiceErr]    = useState('');
  const [noticeSubmitting,  setNoticeSubmitting]  = useState(false);
  const noticeRecorder      = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const noticeSilenceTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeMeteringInt   = useRef<ReturnType<typeof setInterval> | null>(null);
  const noticePulseScale1   = useRef(new Animated.Value(1)).current;
  const noticePulseScale2   = useRef(new Animated.Value(1)).current;
  const noticePulseOpacity1 = useRef(new Animated.Value(0.6)).current;
  const noticePulseOpacity2 = useRef(new Animated.Value(0.4)).current;
  const [cancelOpen,        setCancelOpen]        = useState(false);
  const [addPayOpen,        setAddPayOpen]        = useState(false);
  const [editOccOpen,       setEditOccOpen]       = useState(false);
  const [editNoticeOpen,    setEditNoticeOpen]    = useState(false);
  const [editExitOpen,      setEditExitOpen]      = useState(false);
  const [editRefundOpen,    setEditRefundOpen]    = useState(false);
  const [completeRefundOpen,setCompleteRefundOpen]= useState(false);
  const [undoOnboardId,     setUndoOnboardId]     = useState<string | null>(null);

  // ── Absence (Not in Property) state ──────────────────────────────────────
  const [absenceOpen,    setAbsenceOpen]    = useState(false);
  const [absenceEditId,  setAbsenceEditId]  = useState<string | null>(null);
  const blankAbsence = { allotmentId: '', tenantId: '', fromDate: '', toDate: '', reason: '' };
  const [absenceForm, setAbsenceForm] = useState<any>(blankAbsence);

  // ── bed map ──
  const [mapFilter,  setMapFilter]  = useState<string | null>(null);
  const [mapSearch,  setMapSearch]  = useState('');
  const [mapSortBy,  setMapSortBy]  = useState<'apartment' | 'gender'>('apartment');
  const [bedDetail,  setBedDetail]  = useState<any>(null);

  // ── derived: is any overlay open? ────────────────────────────────────────────
  // Re-evaluated on every render so it's always current
  const anySheetOpen =
    bookingOpen || cancelOpen || onboardOpen || addPayOpen || editOccOpen ||
    switchOpen || noticeOpen || voiceNoticeOpen || editNoticeOpen || exitOpen || editExitOpen ||
    editRefundOpen || completeRefundOpen || absenceOpen || !!bedDetail;

  // Close whichever sheet is currently open
  const closeActiveSheet = useCallback(() => {
    if (bedDetail)           { setBedDetail(null); return; }
    if (bookingOpen)         { setBookingOpen(false); return; }
    if (cancelOpen)          { setCancelOpen(false); return; }
    if (onboardOpen)         { setOnboardOpen(false); setKycFront(null); setKycBack(null); setOnboardProof(null); return; }
    if (addPayOpen)          { setAddPayOpen(false); return; }
    if (editOccOpen)         { setEditOccOpen(false); return; }
    if (switchOpen)          { setSwitchOpen(false); return; }
    if (voiceNoticeOpen)     { setVoiceNoticeOpen(false); return; }
    if (noticeOpen)          { setNoticeOpen(false); return; }
    if (editNoticeOpen)      { setEditNoticeOpen(false); return; }
    if (exitOpen)            { setExitOpen(false); return; }
    if (editExitOpen)        { setEditExitOpen(false); return; }
    if (editRefundOpen)      { setEditRefundOpen(false); return; }
    if (completeRefundOpen)  { setCompleteRefundOpen(false); return; }
    if (absenceOpen)         { setAbsenceOpen(false); return; }
  }, [bedDetail, bookingOpen, cancelOpen, onboardOpen, addPayOpen, editOccOpen,
      switchOpen, noticeOpen, editNoticeOpen, exitOpen, editExitOpen,
      editRefundOpen, completeRefundOpen, absenceOpen]);

  // Lock drawer swipe & block browser/hardware back when any sheet is open
  useEffect(() => {
    // 1. Lock the drawer so swiping doesn't close the screen
    navigation.setOptions?.({ swipeEnabled: !anySheetOpen });

    // 2. Block the beforeRemove event (web browser back button / drawer back gesture)
    if (!anySheetOpen) return;
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      e.preventDefault(); // stops navigation dead
      closeActiveSheet();  // close the topmost sheet instead
    });
    return unsubscribe;
  }, [anySheetOpen, navigation, closeActiveSheet]);

  // ── search ──
  const [tabSearch, setTabSearch] = useState<Record<string, string>>({});

  // ── CC charge rate helper (mirrors web app getCcChargeRate) ───────────────
  const getCcChargeRate = useCallback(() => {
    const pct = Number(config.cc_charge_percent ?? 1.5);
    return Number.isFinite(pct) && pct >= 0 ? pct / 100 : 0.015;
  }, [config.cc_charge_percent]);

  // ── Bank account options for SelectF ──────────────────────────────────────
  const bankAccountOptions = useMemo(() =>
    bankAccounts.map((ba: any) => ({
      label: `${ba.bank_name || 'Bank'}${ba.ifsc_code ? ` (${ba.ifsc_code})` : ''} — ****${String(ba.account_number || '').slice(-4)}${ba.is_primary ? ' • Primary' : ''}`,
      value: ba.id,
    })),
  [bankAccounts]);

  // ── forms ──
  const blankBook = { tenantId: '', bedId: '', onboardingDate: today(), paymentMode: '', refNo: '', amount: '', discount: '0', premium: '0', bankAccountId: '' };
  const [bForm, setBForm] = useState<any>(blankBook);

  const blankOnboard = { allotmentId: '', date: today(), bedId: '', payMode: '', refNo: '', paidAmount: '', bankAccountId: '', ccCharges: '' };
  const [oForm, setOForm] = useState<any>(blankOnboard);

  // ── KYC upload state ──
  const [kycFront, setKycFront] = useState<{ uri: string; base64?: string; mimeType?: string } | null>(null);
  const [kycBack,  setKycBack]  = useState<{ uri: string; base64?: string; mimeType?: string } | null>(null);
  const [kycUploading, setKycUploading] = useState(false);

  // ── Payment proof state (booking + onboarding) ────────────────────────────
  const [bookingProof,   setBookingProof]   = useState<{ uri: string; base64?: string; mimeType?: string } | null>(null);
  const [onboardProof,   setOnboardProof]   = useState<{ uri: string; base64?: string; mimeType?: string } | null>(null);
  // Refund payment proof + its OCR-scanned amount (must EXACTLY match the refund amount to allow completion).
  const [refundProof,       setRefundProof]       = useState<{ uri: string; base64?: string; mimeType?: string } | null>(null);
  const [refundProofAmount, setRefundProofAmount] = useState<number | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  // OCR scan-in-progress flags for the proof tiles (booking / onboarding / refund).
  const [proofScanning, setProofScanning] = useState<{ booking: boolean; onboarding: boolean; refund: boolean }>({ booking: false, onboarding: false, refund: false });
  // Always-fresh bank-accounts snapshot so the OCR matcher (in a []-dep callback) isn't stale.
  const bankAccountsRef = useRef<any[]>([]);
  bankAccountsRef.current = bankAccounts;
  // Fresh refund-amount snapshot for the OCR exact-match check (runProofOcr has []-deps). Assigned after completeRefundForm is declared.
  const refundDueRef = useRef<number>(0);

  // Scan an uploaded payment screenshot and auto-fill amount / mode / txn ref / bank.
  // Mirrors the web TenantLifecycle handleProofSelectAndOcr + the technician flow.
  const runProofOcr = useCallback(async (target: 'booking' | 'onboarding' | 'refund', base64?: string, uri?: string) => {
    // The image picker (with allowsEditing) frequently returns NO base64 on
    // Android, and full-res screenshots can be too large — so re-encode a
    // resized JPEG from the uri to guarantee usable base64 for the OCR call.
    let b64 = base64;
    if (uri) {
      try {
        const IM: any = await import('expo-image-manipulator');
        const FS: any = await import('expo-file-system');
        const manip = await IM.manipulateAsync(uri, [{ resize: { width: 1400 } }], { compress: 0.7, format: IM.SaveFormat.JPEG });
        const encoded = await FS.readAsStringAsync(manip.uri, { encoding: 'base64' });
        if (encoded) b64 = encoded;
      } catch { /* fall back to any picker-provided base64 */ }
    }
    if (!b64) { Alert.alert('Scan skipped', 'Could not read that image to scan. Please enter the payment details manually.'); return; }
    setProofScanning(p => ({ ...p, [target]: true }));
    try {
      const ocr: any = await extractPaymentProof(b64);
      const scanned = ocr && ocr.amount != null ? Math.round(Number(ocr.amount)) : null;
      const mode = mapOcrPaymentMode(ocr?.bank_name);
      // Match a saved org bank account by name (best-effort, same as technician flow).
      let matchedBankId: string | undefined;
      if (ocr?.bank_name) {
        const name = String(ocr.bank_name).toLowerCase();
        const matched = bankAccountsRef.current.find((ba: any) => {
          const bn = String(ba.bank_name || '').toLowerCase();
          return bn && (bn.includes(name) || name.includes(bn));
        });
        if (matched) matchedBankId = matched.id;
      }

      // ── Refund: the amount is FIXED (read-only). Store the scanned amount so the
      //    UI + submit can enforce an EXACT match against the refund amount. ──────
      if (target === 'refund') {
        setRefundProofAmount(scanned);
        setCompleteRefundForm((p: any) => ({
          ...p,
          referenceNumber: (ocr && ocr.transaction_reference) || p.referenceNumber,
          bankAccountId:   matchedBankId || p.bankAccountId,
        }));
        const due = refundDueRef.current;
        if (scanned == null) {
          Alert.alert('Amount not readable', `Could not read the amount from this screenshot. The refund stays blocked until a clear screenshot showing ₹${due} is uploaded.`);
        } else if (scanned === due) {
          Alert.alert('✓ Amount verified', `Screenshot amount ₹${scanned} matches the refund amount — you can complete the refund.`);
        } else {
          Alert.alert('✗ Amount mismatch', `Screenshot shows ₹${scanned} but the refund amount is ₹${due}. Only a screenshot with the exact refund amount is allowed.`);
        }
        return;
      }

      if (ocr && (ocr.amount || ocr.payment_date || ocr.bank_name || ocr.transaction_reference)) {
        if (target === 'booking') {
          setBForm((p: any) => ({
            ...p,
            amount:        ocr.amount ? String(Math.round(Number(ocr.amount))) : p.amount,
            refNo:         ocr.transaction_reference || p.refNo,
            paymentMode:   mode || p.paymentMode,
            bankAccountId: matchedBankId || p.bankAccountId,
          }));
        } else {
          setOForm((p: any) => ({
            ...p,
            paidAmount:    ocr.amount ? String(Math.round(Number(ocr.amount))) : p.paidAmount,
            refNo:         ocr.transaction_reference || p.refNo,
            payMode:       mode || p.payMode,
            bankAccountId: matchedBankId || p.bankAccountId,
          }));
        }
        if (ocr.amount) {
          Alert.alert(
            'Payment scanned',
            `Amount: ₹${Math.round(Number(ocr.amount))}` +
            `${ocr.bank_name ? `\nMode: ${ocr.bank_name}` : ''}` +
            `${ocr.transaction_reference ? `\nRef: ${ocr.transaction_reference}` : ''}` +
            `${ocr.payment_date ? `\nDate: ${ocr.payment_date}` : ''}` +
            `\n\nFields auto-filled — please verify.`,
          );
        }
      } else if (ocr && ocr._requireManualAmount) {
        Alert.alert('Scan unavailable', ocr._message || 'Could not read the screenshot. Please enter the payment details manually.');
      }
    } catch {
      // Non-blocking — the user can still fill the fields by hand.
    } finally {
      setProofScanning(p => ({ ...p, [target]: false }));
    }
  }, []);

  // ── Proof picker — gallery OR camera (mirrors web UnifiedImagePicker) ──────
  // Gallery / camera launchers factored out so we can call them directly on web
  // (react-native-web's Alert.alert ignores button onPress callbacks, so the
  //  action-sheet path below never fires there → gallery would never open).
  const openProofGallery = useCallback(async (target: 'booking' | 'onboarding' | 'refund') => {
    const setFn = target === 'booking' ? setBookingProof : target === 'onboarding' ? setOnboardProof : setRefundProof;
    try {
      const ImagePicker = await import('expo-image-picker') as any;
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission Required', 'Allow photo library access to upload proof.'); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8, base64: true });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setFn({ uri: asset.uri, base64: asset.base64 ?? undefined, mimeType: asset.mimeType ?? 'image/jpeg' });
      runProofOcr(target, asset.base64 ?? undefined, asset.uri);
    } catch (e: any) { Alert.alert('Error', e.message || 'Could not open gallery.'); }
  }, [runProofOcr]);

  const openProofCamera = useCallback(async (target: 'booking' | 'onboarding' | 'refund') => {
    const setFn = target === 'booking' ? setBookingProof : target === 'onboarding' ? setOnboardProof : setRefundProof;
    try {
      const ImagePicker = await import('expo-image-picker') as any;
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission Required', 'Allow camera access to take a photo.'); return; }
      const result = await ImagePicker.launchCameraAsync({ allowsEditing: true, quality: 0.8, base64: true });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setFn({ uri: asset.uri, base64: asset.base64 ?? undefined, mimeType: asset.mimeType ?? 'image/jpeg' });
      runProofOcr(target, asset.base64 ?? undefined, asset.uri);
    } catch (e: any) { Alert.alert('Error', e.message || 'Could not open camera.'); }
  }, [runProofOcr]);

  const pickProof = useCallback(async (target: 'booking' | 'onboarding' | 'refund') => {
    // Web: Alert.alert button callbacks don't fire on react-native-web, so open
    // the gallery/file-picker directly instead of the (dead) action sheet.
    if (Platform.OS === 'web') { openProofGallery(target); return; }
    Alert.alert('Upload Proof', 'Choose how to attach payment proof', [
      { text: 'Choose from Gallery', onPress: () => openProofGallery(target) },
      { text: 'Take Photo', onPress: () => openProofCamera(target) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [openProofGallery, openProofCamera]);

  const blankSwitch = { allotmentId: '', tenantId: '', oldBedId: '', newBedId: '', switchDate: today(), oldRate: 0, newRate: 0, newAptId: '', newPropId: '' };
  const [swForm, setSwForm] = useState<any>(blankSwitch);
  // Tenant statement modal (opened from a switch row's "View").
  const [stmtCtx, setStmtCtx]         = useState<any>(null);
  const [stmtTab, setStmtTab]         = useState<'ledger' | 'deposit' | 'summary'>('ledger');
  const [stmtInvoices, setStmtInvoices] = useState<any[]>([]);
  const [stmtReceipts, setStmtReceipts] = useState<any[]>([]);
  const [stmtLoading, setStmtLoading] = useState(false);
  const [depEdit, setDepEdit]         = useState<{ editing: boolean; value: string }>({ editing: false, value: '' });

  const blankNotice = { allotmentId: '', tenantId: '', bedId: '', exitDate: '', notes: '' };
  const [nForm, setNForm] = useState<any>(blankNotice);

  const blankExit = { allotmentId: '', tenantId: '', bedId: '', exitDate: today(), damageCharges: '0', ebCharges: '0', keyReturned: true, hasNotice: false, notes: '', inspectFurniture: false, inspectBed: false, inspectWalls: false, inspectBathroom: false };
  const [eForm, setEForm] = useState<any>(blankExit);
  // Exit-month estimated-EB recompute (item 6) — recomputed from the actual exit date.
  const [exitEb, setExitEb] = useState<{ recomputed: number; invoicedOriginal: number; estimatedEbIncluded: boolean; canRecompute: boolean; daysInExitMonth: number } | null>(null);
  const [exitEbLoading, setExitEbLoading] = useState(false);

  // Recompute exit-month EB whenever the allotment or actual exit date changes.
  // Read-only — the invoice is only revised on completion (inside processExitFull).
  useEffect(() => {
    if (!exitOpen || !eForm.allotmentId || !eForm.exitDate) { setExitEb(null); return; }
    let active = true;
    setExitEbLoading(true);
    (client.action as any)((api as any).tenants.computeExitMonthEb, {
      allotmentId: eForm.allotmentId,
      exitDate: eForm.exitDate,
    })
      .then((r: any) => { if (active) setExitEb(r); })
      .catch(() => { if (active) setExitEb(null); })
      .finally(() => { if (active) setExitEbLoading(false); });
    return () => { active = false; };
  }, [exitOpen, eForm.allotmentId, eForm.exitDate]);

  const [cancelId, setCancelId]         = useState('');
  const [addPayForm, setAddPayForm]     = useState<any>({ allotmentId: '', amount: '', paymentMode: '', refNo: '', bankAccountId: '', ccCharges: '' });
  const [editOccForm, setEditOccForm]   = useState<any>({ allotmentId: '', onboardingDate: '', discount: '0', premium: '0', depositPaid: '' });
  const [editNoticeForm, setEditNoticeForm] = useState<any>({ noticeId: '', allotmentId: '', bedId: '', tenantId: '', noticeDate: '', exitDate: '', notes: '' });
  const [editExitForm, setEditExitForm] = useState<any>({ exitId: '', allotmentId: '', exitDate: '', hasNotice: false, keyReturned: true, damageCharges: '0', notes: '' });
  const [editRefundForm, setEditRefundForm] = useState<any>({ exitId: '', allotmentId: '', advanceHeld: 0, pendingRent: '0', ebCharges: '0', exitCharges: '0', damageCharges: '0', keyLossFee: '0' });
  const [completeRefundForm, setCompleteRefundForm] = useState<any>({ exitId: '', allotmentId: '', tenantId: '', tenantName: '', refundDue: 0, refundDate: today(), referenceNumber: '', bankAccountId: '' });
  refundDueRef.current = Math.round(Number(completeRefundForm.refundDue) || 0);

  // ─── FETCH ─────────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [data, switches, rcpts, preExitTasks] = await Promise.all([
        client.action((api as any).tenants.getLifecycleFullData, {}),
        client.action((api as any).tenants.listRoomSwitches, {}).catch(() => []),
        client.action((api as any).tenants.listLifecycleReceipts, {}).catch(() => []),
        client.action((api as any).tenantsextraactions.listExitTasks, {}).catch(() => []),
      ]);

      if (!mounted.current) return;
      setExitTasks(preExitTasks || []);
      setAllotments(data.allotments || []);
      setTenants(data.tenants || []);
      setBeds(data.beds || []);
      setApartments(data.apartments || []);
      setProperties(data.properties || []);
      setExits(data.exits || []);
      setNotices(data.notices || []);
      setBedRates(data.bedRates || []);
      setConfig({ cc_charge_percent: 1.5, ...(data.config || {}) });
      setBankAccounts(data.bankAccounts || []);
      setAbsenceRecords(data.absenceRecords || []);
      setRoomSwitches(switches || []);
      setReceipts(rcpts || []);
    } catch (e) {
      if (!isAbortError(e)) console.warn('[TenantLifecycle] fetch error', e);
    } finally {
      if (mounted.current) { setLoading(false); setRefreshing(false); }
    }
  }, [mounted]);

  useFocusEffect(useCallback(() => { fetchAll(); }, [fetchAll]));

  const onRefresh = () => { setRefreshing(true); fetchAll(); };

  // ─── DERIVED ───────────────────────────────────────────────────────────────

  const liveAptIds = useMemo(() =>
    new Set(apartments.filter((a: any) => (a.status || '').toLowerCase() === 'live').map((a: any) => a.id)),
  [apartments]);

  const liveBeds = useMemo(() =>
    beds.filter((b: any) => liveAptIds.has(b.apartment_id) && (b.status || '').toLowerCase() === 'live'),
  [beds, liveAptIds]);

  // Derive bed status from allotments (source of truth)
  const getBedStatusFromAllotments = useCallback((bedId: string): string => {
    const active = allotments.filter((a: any) =>
      a.bed_id === bedId && ['Staying', 'On-Notice', 'Booked'].includes(a.staying_status)
    );
    const onNotice = active.find((a: any) => a.staying_status === 'On-Notice');
    const booked   = active.find((a: any) => a.staying_status === 'Booked');
    const staying  = active.find((a: any) => a.staying_status === 'Staying');
    if (onNotice && booked) return 'notice-booked';
    if (staying) return 'occupied';
    if (onNotice) return 'notice';
    if (booked) return 'booked';
    return 'vacant';
  }, [allotments]);

  // Bed rate helper
  const getBedRate = useCallback((bedId: string, date?: string): number => {
    const bed = beds.find((b: any) => b.id === bedId);
    if (!bed) return 0;
    const apt = apartments.find((a: any) => a.id === bed.apartment_id);
    const propertyId = apt?.property_id || null;
    const targetDate = date || today();
    const matching = bedRates.filter((r: any) =>
      r.bed_type === bed.bed_type && r.toilet_type === bed.toilet_type &&
      r.from_date <= targetDate && (!r.to_date || r.to_date >= targetDate)
    );
    if (!matching.length) return 0;
    if (propertyId) {
      const propSpec = matching.filter((r: any) => r.property_id === propertyId)
        .sort((a: any, b: any) => b.from_date.localeCompare(a.from_date));
      if (propSpec.length) return propSpec[0].monthly_rate;
    }
    return matching.sort((a: any, b: any) => b.from_date.localeCompare(a.from_date))[0].monthly_rate;
  }, [beds, apartments, bedRates]);

  const bedCounts = useMemo(() => {
    const c = { vacant: 0, booked: 0, occupied: 0, notice: 0 };
    liveBeds.forEach((b: any) => {
      const s = getBedStatusFromAllotments(b.id);
      if (s === 'vacant') c.vacant++;
      else if (s === 'occupied') c.occupied++;
      else if (s === 'notice' || s === 'notice-booked') c.notice++;
      else if (s === 'booked') c.booked++;
    });
    return c;
  }, [liveBeds, getBedStatusFromAllotments]);

  const bookedAllotments  = useMemo(() => allotments.filter((a: any) => a.staying_status === 'Booked'), [allotments]);
  const stayingAllotments = useMemo(() => allotments.filter((a: any) => a.staying_status === 'Staying'), [allotments]);
  const onNotice          = useMemo(() => allotments.filter((a: any) => a.staying_status === 'On-Notice'), [allotments]);
  const pendingPayments   = useMemo(() => stayingAllotments.filter((a: any) => ['partial', 'pending'].includes(a.payment_status || '')), [stayingAllotments]);
  const pendingRefunds    = useMemo(() => exits.filter((e: any) => e.refund_status === 'pending'), [exits]);
  const overdueRefunds    = useMemo(() => pendingRefunds.filter((e: any) => daysBetween(e.exit_date) > (config.refund_deadline_days || 5)), [pendingRefunds, config]);

  const eligibleTenants = useMemo(() =>
    tenants.filter((t: any) => {
      if (t.kyc_completed !== true) return false;
      const s = (t.staying_status || 'new').toLowerCase();
      return s === 'new';
    }), [tenants]);

  const returningTenants = useMemo(() => {
    const exitedIds = new Set(allotments.filter((a: any) => a.staying_status === 'Exited').map((a: any) => a.tenant_id));
    const activeIds = new Set(allotments.filter((a: any) => ['Staying','On-Notice','Booked'].includes(a.staying_status)).map((a: any) => a.tenant_id));
    return tenants.filter((t: any) => exitedIds.has(t.id) && !activeIds.has(t.id));
  }, [tenants, allotments]);

  const aptById  = useMemo(() => { const m: Record<string, any> = {}; apartments.forEach((a: any) => { m[a.id] = a; }); return m; }, [apartments]);
  const propById = useMemo(() => { const m: Record<string, any> = {}; properties.forEach((p: any) => { m[p.id] = p; }); return m; }, [properties]);
  const bedById  = useMemo(() => { const m: Record<string, any> = {}; beds.forEach((b: any) => { m[b.id] = b; }); return m; }, [beds]);

  // Available beds for booking
  const vacantBeds = useMemo(() =>
    liveBeds
      .filter((b: any) => getBedStatusFromAllotments(b.id) === 'vacant')
      .map((b: any) => {
        const apt = aptById[b.apartment_id] || {};
        return { ...b, _aptCode: apt.apartment_code || '?' };
      })
      .sort((a: any, b: any) => `${a._aptCode}-${a.bed_code}`.localeCompare(`${b._aptCode}-${b.bed_code}`)),
  [liveBeds, getBedStatusFromAllotments, aptById]);

  const noticeBeds = useMemo(() =>
    liveBeds.filter((b: any) => getBedStatusFromAllotments(b.id) === 'notice')
      .map((b: any) => ({ ...b, _aptCode: (aptById[b.apartment_id] || {}).apartment_code || '?' }))
      .sort((a: any, b: any) => `${a._aptCode}-${a.bed_code}`.localeCompare(`${b._aptCode}-${b.bed_code}`)),
  [liveBeds, getBedStatusFromAllotments, aptById]);

  // Booking cost helper
  const calcOnboardingCosts = useCallback((allotmentId: string, onboardDate: string, overrideBedId?: string) => {
    const allot = allotments.find((a: any) => a.id === allotmentId);
    if (!allot) return null;
    const bedId = overrideBedId || allot.bed_id;
    const monthlyRent = getBedRate(bedId, onboardDate);
    const discount = allot.discount || 0;
    const premium = allot.premium || 0;
    const effectiveRent = Math.max(0, monthlyRent - discount + premium);
    const advance = Math.ceil(effectiveRent * (config.advance_ratio || 1.5));
    const onDate = new Date(onboardDate);
    const daysInMonth = getDaysInMonth(onDate);
    const remainingDays = daysInMonth - onDate.getDate() + 1;
    const proratedRent = Math.ceil((effectiveRent / daysInMonth) * remainingDays);
    const onboardingCharges = config.onboarding_fee || 1000;
    const totalDue = Math.ceil(onboardingCharges + advance + proratedRent);
    const alreadyPaid = Math.max(allot.paid_amount || 0, allot.deposit_paid || 0);
    const balance = Math.ceil(totalDue - alreadyPaid);
    return { monthlyRent: Math.ceil(monthlyRent), effectiveRent: Math.ceil(effectiveRent), discount, premium, advance, proratedRent, remainingDays, daysInMonth, onboardingCharges, totalDue, alreadyPaid, balance };
  }, [allotments, getBedRate, config]);

  // Default "Amount Paying Now" at onboarding to just the deposit (advance = rent ×1.5).
  // The field stays editable; this only sets a sensible starting value. Recomputed
  // whenever the allotment / date / bed changes.
  const depositDefault = useCallback((allotmentId: string, date: string, bedId?: string) => {
    const c = calcOnboardingCosts(allotmentId, date, bedId);
    return c ? String(c.advance) : '';
  }, [calcOnboardingCosts]);

  // ─── MUTATIONS ─────────────────────────────────────────────────────────────

  const withSave = async (fn: () => Promise<void>) => {
    setSaving(true);
    try { await fn(); } finally { setSaving(false); }
  };

  async function doCreateBooking() {
    if (!bForm.tenantId || !bForm.bedId || !bForm.onboardingDate || !bForm.paymentMode) {
      return Alert.alert('Validation', 'Fill Tenant, Bed, Onboarding Date and Payment Mode.');
    }
    await withSave(async () => {
      const bed = bedById[bForm.bedId];
      const apt = aptById[bed?.apartment_id] || {};
      const bedStatus = getBedStatusFromAllotments(bForm.bedId);
      const amt = parseFloat(bForm.amount) || config.booking_fee || 1000;

      // Upload payment proof if attached (non-blocking — booking proceeds even if upload fails)
      let bookingProofUrl: string | null = null;
      if (bookingProof) {
        setProofUploading(true);
        try {
          bookingProofUrl = await uploadPaymentProof(
            bookingProof.uri, 'booking', bForm.tenantId,
            bookingProof.base64, bookingProof.mimeType
          );
        } catch (e) { console.warn('[Booking proof upload]', e); }
        finally { setProofUploading(false); }
      }

      await client.action((api as any).tenants.createBookingFull, {
        data: {
          tenantId: bForm.tenantId, bedId: bForm.bedId,
          propertyId: apt.property_id || '', apartmentId: apt.id || '',
          onboardingDate: bForm.onboardingDate,
          amount: amt, paymentMode: bForm.paymentMode, referenceNumber: bForm.refNo || null,
          discount: parseFloat(bForm.discount) || 0, premium: parseFloat(bForm.premium) || 0,
          isBedOnNotice: bedStatus === 'notice',
          bankAccountId: bForm.bankAccountId || null,
          ...(bookingProofUrl ? { proofUrl: bookingProofUrl } : {}),
        },
      });
      Alert.alert('Success', 'Booking created!' + (bookingProofUrl ? '\nPayment proof uploaded.' : ''));
      setBookingOpen(false); setBForm(blankBook); setBookingProof(null); fetchAll();
    });
  }

  async function doCancelBooking() {
    if (!cancelId) return;
    Alert.alert('Confirm', 'Cancel this booking? This cannot be undone.', [
      { text: 'No', style: 'cancel' },
      { text: 'Cancel Booking', style: 'destructive', onPress: async () => {
        await withSave(async () => {
          await client.action((api as any).tenants.cancelBookingFull, { allotmentId: cancelId, reason: 'Cancelled by admin' });
          Alert.alert('Done', 'Booking cancelled.'); setCancelOpen(false); setCancelId(''); fetchAll();
        });
      }},
    ]);
  }

  // ── KYC photo picker ─────────────────────────────────────────────────────────
  const pickKycPhoto = async (side: 'front' | 'back') => {
    try {
      const ImagePicker = await import('expo-image-picker') as any;
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.8,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const photo = { uri: asset.uri, base64: asset.base64 ?? undefined, mimeType: asset.mimeType ?? 'image/jpeg' };
      if (side === 'front') setKycFront(photo);
      else setKycBack(photo);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not open photo library.');
    }
  };

  async function doOnboard() {
    if (!oForm.allotmentId || !oForm.date) return Alert.alert('Validation', 'Select allotment and date.');
    if (!kycFront || !kycBack) return Alert.alert('KYC Required', 'Please upload both front and back KYC documents before completing onboarding.');
    const costs = calcOnboardingCosts(oForm.allotmentId, oForm.date, oForm.bedId);
    if (!costs) return Alert.alert('Error', 'Cannot calculate costs.');
    const paidNow = parseFloat(oForm.paidAmount) || 0;

    // Upload KYC photos first (non-blocking — onboarding proceeds even if upload fails)
    let kycFrontUrl: string | null = null;
    let kycBackUrl:  string | null = null;
    if (kycFront || kycBack) {
      setKycUploading(true);
      const allotment = bookedAllotments.find((a: any) => a.id === oForm.allotmentId);
      const tenantId = allotment?.tenant_id || allotment?.tenants?.id || 'unknown';
      try {
        [kycFrontUrl, kycBackUrl] = await Promise.all([
          kycFront ? uploadKycPhoto(kycFront.uri, 'front', tenantId, kycFront.base64, kycFront.mimeType) : Promise.resolve(null),
          kycBack  ? uploadKycPhoto(kycBack.uri,  'back',  tenantId, kycBack.base64,  kycBack.mimeType)  : Promise.resolve(null),
        ]);
      } catch (e) {
        console.warn('[KYC upload]', e);
      } finally {
        setKycUploading(false);
      }
    }

    await withSave(async () => {
      // Upload payment proof (non-blocking — onboarding proceeds even if upload fails)
      let onboardProofUrl: string | null = null;
      if (onboardProof) {
        setProofUploading(true);
        const allotment = bookedAllotments.find((a: any) => a.id === oForm.allotmentId);
        const tId = allotment?.tenant_id || 'unknown';
        try {
          onboardProofUrl = await uploadPaymentProof(
            onboardProof.uri, 'onboarding', tId,
            onboardProof.base64, onboardProof.mimeType
          );
        } catch (e) { console.warn('[Onboard proof upload]', e); }
        finally { setProofUploading(false); }
      }

      await client.action((api as any).tenants.processOnboardingFull, {
        data: {
          allotmentId: oForm.allotmentId, onboardingDate: oForm.date,
          bedId: oForm.bedId, paymentMode: oForm.payMode, referenceNumber: oForm.refNo,
          paidAmount: paidNow, monthlyRent: costs.monthlyRent, advance: costs.advance,
          proratedRent: costs.proratedRent, onboardingCharges: costs.onboardingCharges,
          totalDue: costs.totalDue,
          bankAccountId: oForm.bankAccountId || null,
          ccCharges: parseFloat(oForm.ccCharges) || 0,
          ...(kycFrontUrl ? { kycFrontUrl } : {}),
          ...(kycBackUrl  ? { kycBackUrl  } : {}),
          ...(onboardProofUrl ? { proofUrl: onboardProofUrl } : {}),
        },
      });
      const extras = [
        kycFrontUrl || kycBackUrl ? 'KYC documents uploaded.' : '',
        onboardProofUrl ? 'Payment proof uploaded.' : '',
      ].filter(Boolean).join(' ');
      Alert.alert('Success', 'Tenant onboarded!' + (extras ? '\n' + extras : ''));
      setOnboardOpen(false);
      setOForm(blankOnboard);
      setKycFront(null);
      setKycBack(null);
      setOnboardProof(null);
      fetchAll();
    });
  }

  // ── Build RegistrationPdfData from the current onboard form + allotment ──
  async function buildRegData(): Promise<RegistrationPdfData | null> {
    if (!oForm.allotmentId) { Alert.alert('Select an allotment first'); return null; }
    const costs = calcOnboardingCosts(oForm.allotmentId, oForm.date, oForm.bedId);
    const allot = bookedAllotments.find((a: any) => a.id === oForm.allotmentId);
    // Pull rich tenant/apt/bed details from backend (web parity)
    let rich: any = null;
    try { rich = await sb.getOnboardingRegistrationData(oForm.allotmentId); } catch {}
    const t = rich?.tenant || allot?.tenants || {};
    const apt = rich?.apartment || allot?.apartments || {};
    const bed = rich?.bed || allot?.beds || {};
    const fullName = t.full_name || [t.first_name, t.last_name].filter(Boolean).join(' ') || '';
    const nameParts = String(fullName).split(' ');
    const ba = (bankAccounts || []).find((b: any) => b.id === oForm.bankAccountId);
    const maskedAcct = (n?: string) => (n ? `••••${String(n).slice(-4)}` : '');
    return {
      firstName: t.first_name || nameParts[0] || '',
      lastName: t.last_name || nameParts.slice(1).join(' ') || '',
      address: t.address || t.permanent_address || '',
      city: t.city || '',
      email: t.email || '',
      aadhaarNumber: t.aadhar_number || t.id_proof_number || '',
      aadhaarProvided: Boolean(t.aadhar_image_url || kycFront),
      companyName: t.company_name || '',
      mobile: t.phone || '',
      parentMobile: t.emergency_contact_phone || '',
      aptNo: apt.apartment_code || '',
      roomNo: bed.bed_code || '',
      bedType: bed.bed_type || '',
      toiletType: bed.toilet_type || '',
      startDate: oForm.date || '',
      stayPeriod: '',
      refundableAdvance: costs?.advance ?? 0,
      rentalAmount: costs?.proratedRent ?? 0,
      calculatedFromDate: oForm.date || '',
      vehicleType: '',
      vehicleNumber: '',
      vehicleCharge: '',
      onBoardingCharges: costs?.onboardingCharges ?? 1000,
      ccCharges: oForm.ccCharges || '',
      totalDue: (Number(costs?.totalDue ?? 0)) + (parseFloat(oForm.ccCharges) || 0),
      paymentMode: oForm.payMode || '',
      referenceNumber: oForm.refNo || '',
      paidVia: oForm.payMode || '',
      paidAmount: (parseFloat(oForm.paidAmount) || 0) + (parseFloat(oForm.ccCharges) || 0) || '',
      bankAccount: ba ? `${ba.bank_name || 'Bank'}${ba.ifsc_code ? ` (${ba.ifsc_code})` : ''} ${maskedAcct(ba.account_number)}` : '',
    };
  }

  async function handleGenerateRegistration() {
    setRegGenerating(true);
    try {
      const data = await buildRegData();
      if (!data) return;
      setRegData(data);
      setRegTicks({});
      // Generate an initial (un-ticked) preview PDF
      const { uri } = await generateRegistrationPdf(data, {});
      setRegPdfUri(uri);
      setRegPreviewOpen(true);
    } catch (e: any) {
      Alert.alert('PDF generation failed', e?.message || 'Could not generate the Registration PDF.');
    } finally {
      setRegGenerating(false);
    }
  }

  const allTicked = TERMS_OF_STAY.every((t) => regTicks[t.id]);

  async function handleRegenerateWithTicks() {
    if (!regData) return;
    try {
      const { uri } = await generateRegistrationPdf(regData, regTicks);
      setRegPdfUri(uri);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not update the PDF.');
    }
  }

  async function handleShareRegistration() {
    if (!regData) return;
    try {
      // Re-render with current ticks baked in, then share
      const { uri } = await generateRegistrationPdf(regData, regTicks);
      setRegPdfUri(uri);
      await shareRegistrationPdf(uri);
    } catch (e: any) {
      Alert.alert('Share failed', e?.message || 'Could not share the PDF.');
    }
  }

  async function handleSendWhatsapp() {
    if (!oForm.allotmentId || !regData) return;
    setRegSendingWa(true);
    try {
      const res = await sb.sendOnboardingKycWhatsapp(oForm.allotmentId, regData as any);
      if (res?.ok) {
        Alert.alert(
          res.alreadySubmitted ? 'Already Submitted' : 'Sent on WhatsApp',
          res.alreadySubmitted
            ? 'This tenant has already submitted their Registration Form.'
            : 'The Registration Form link was sent to the tenant on WhatsApp.'
        );
      } else {
        // Edge function unavailable → offer share-sheet fallback
        Alert.alert(
          'WhatsApp send unavailable',
          (res?.reason ? `${res.reason}\n\n` : '') + 'You can share the PDF directly via WhatsApp instead.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Share PDF', onPress: handleShareRegistration },
          ]
        );
      }
    } catch (e: any) {
      Alert.alert(
        'WhatsApp send failed',
        (e?.message ? `${e.message}\n\n` : '') + 'You can share the PDF directly instead.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Share PDF', onPress: handleShareRegistration }]
      );
    } finally {
      setRegSendingWa(false);
    }
  }

  async function doUndoOnboarding(allotmentId: string) {
    Alert.alert('Confirm Undo', 'Revert this tenant back to Booked status?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Undo Onboarding', style: 'destructive', onPress: async () => {
        await withSave(async () => {
          await client.action((api as any).tenants.undoOnboardingFull, { allotmentId });
          Alert.alert('Done', 'Tenant reverted to Booked.'); setUndoOnboardId(null); fetchAll();
        });
      }},
    ]);
  }

  async function doSwitch() {
    if (!swForm.allotmentId || !swForm.newBedId) return Alert.alert('Validation', 'Select tenant and new bed.');
    await withSave(async () => {
      await client.action((api as any).tenants.processSwitchFull, {
        data: {
          allotmentId: swForm.allotmentId, tenantId: swForm.tenantId,
          oldBedId: swForm.oldBedId, newBedId: swForm.newBedId,
          oldRate: swForm.oldRate, newRate: swForm.newRate,
          newApartmentId: swForm.newAptId, newPropertyId: swForm.newPropId,
          switchDate: swForm.switchDate || today(),
        },
      });
      Alert.alert('Success', 'Room switch processed!'); setSwitchOpen(false); setSwForm({ ...blankSwitch }); fetchAll();
    });
  }

  // Open the tenant statement — fetch this tenant's invoices (charges) on demand;
  // payments come from the already-loaded `receipts`.
  async function openStatement(s: any) {
    setStmtCtx({ tenantId: s.tenantId, tenantName: s.tenantName, allotmentId: s.allotmentId });
    setStmtTab('ledger');
    setStmtInvoices([]);
    setStmtReceipts([]);
    setStmtLoading(true);
    try {
      // Invoices = charges (debits). listReceipts = ALL payments incl. monthly rent
      // (the lifecycle receipts list is filtered and misses rent → wrong credits).
      const [inv, rec] = await Promise.all([
        client.action((api as any).accounting.listInvoices, { tenantId: s.tenantId }),
        client.action((api as any).accounting.listReceipts, {}).catch(() => []),
      ]);
      setStmtInvoices(inv || []);
      setStmtReceipts((rec || [])
        .filter((r: any) => r.tenant_id === s.tenantId)
        .map((r: any) => ({
          _id: r.id,
          tenantId: r.tenant_id,
          amountPaid: Number(r.amount_paid) || 0,
          paymentMode: r.payment_mode || '',
          referenceNumber: r.reference_number || '',
          paymentDate: r.payment_date || (r.created_at || '').split('T')[0] || '',
          receiptType: r.receipt_type || '',
        })));
    } catch { setStmtInvoices([]); setStmtReceipts([]); }
    setStmtLoading(false);
  }

  // Deposit Ledger edit — updates deposit_paid on the allotment (all other
  // allotment fields preserved so updateAllotmentDetails doesn't wipe them).
  async function doSaveDeposit(allot: any, value: string) {
    if (!allot) { Alert.alert('No allotment', 'No active allotment found to edit.'); return; }
    await withSave(async () => {
      await client.action((api as any).tenants.updateAllotmentDetails, {
        data: {
          allotmentId:   allot.id,
          onboardingDate: allot.onboarding_date || '',
          discount:      allot.discount || 0,
          premium:       allot.premium || 0,
          depositPaid:   parseFloat(value) || 0,
        },
      });
      setDepEdit({ editing: false, value: '' });
      fetchAll();
    });
  }

  // Create a pre-exit task for an on-notice tenant (auto-assigned to org staff).
  async function doCreatePreExitTask(a: any) {
    const exitDate = a.estimated_exit_date || '';
    if (!exitDate) { Alert.alert('Missing date', 'This notice has no estimated exit date. Edit the notice to set one first.'); return; }
    await withSave(async () => {
      await client.action((api as any).tenantsextraactions.createExitTask, {
        data: { allotmentId: a.id, tenantId: a.tenant_id, exitDate },
      });
      Alert.alert('Pre-Exit Task Created', 'Assigned to the exit-task staff configured in Settings.');
      fetchAll();
    });
  }

  // Reswitch: prefill the New Switch sheet for a tenant using their current allotment.
  function doReswitch(s: any) {
    const a = stayingAllotments.find((x: any) => x.tenant_id === s.tenantId)
           || allotments.find((x: any) => x.tenant_id === s.tenantId && x.staying_status === 'Staying');
    if (!a) { Alert.alert('Cannot reswitch', 'No active (Staying) allotment found for this tenant.'); return; }
    const rate = getBedRate(a.bed_id);
    setSwForm({ ...blankSwitch, allotmentId: a.id, tenantId: s.tenantId, oldBedId: a.bed_id, oldRate: rate, switchDate: today() });
    setSwitchOpen(true);
  }

  // ── Voice Notice helpers ─────────────────────────────────────────────────
  const clearNoticeTimers = useCallback(() => {
    if (noticeSilenceTimer.current)  { clearTimeout(noticeSilenceTimer.current);  noticeSilenceTimer.current = null; }
    if (noticeMeteringInt.current)   { clearInterval(noticeMeteringInt.current);   noticeMeteringInt.current = null; }
  }, []);

  const stopNoticeRecording = useCallback(async () => {
    clearNoticeTimers();
    try {
      setNoticeRecState('transcribing');
      if (!noticeRecorder.isRecording && !noticeRecorder.uri) { setNoticeRecState('idle'); return; }
      await noticeRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = noticeRecorder.uri;
      if (!uri) { setNoticeVoiceErr('No audio captured. Please try again.'); setNoticeRecState('error'); return; }

      const FileSystem = await import('expo-file-system') as any;
      const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const resp = await fetch(TRANSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64, mimeType: 'audio/m4a' }),
      });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e?.error || `Transcription error (${resp.status})`); }
      const data = await resp.json();
      const text = (data.transcription || '').trim();
      if (!text) { setNoticeVoiceErr('No speech detected. Please speak clearly and try again.'); setNoticeRecState('error'); return; }
      setNoticeTranscript(text);
      setNoticeRecState('done');
    } catch (err: any) {
      setNoticeVoiceErr(err?.message || 'Transcription failed.');
      setNoticeRecState('error');
    }
  }, [clearNoticeTimers]);

  const startNoticeRecording = useCallback(async () => {
    try {
      setNoticeTranscript('');
      setNoticeVoiceErr('');
      setNoticeRecState('recording');
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) { setNoticeVoiceErr('Microphone permission denied.'); setNoticeRecState('error'); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await noticeRecorder.prepareToRecordAsync();
      noticeRecorder.record();
      noticeMeteringInt.current = setInterval(async () => {
        try {
          const status = noticeRecorder.getStatus();
          if (!status.isRecording) return;
          const level = (status as any).metering ?? -160;
          if (level < -40) {
            if (!noticeSilenceTimer.current) {
              noticeSilenceTimer.current = setTimeout(() => stopNoticeRecording(), 2000);
            }
          } else {
            if (noticeSilenceTimer.current) { clearTimeout(noticeSilenceTimer.current); noticeSilenceTimer.current = null; }
          }
        } catch (_) {}
      }, 200);
    } catch (err: any) {
      setNoticeVoiceErr(err?.message || 'Could not start microphone.');
      setNoticeRecState('error');
    }
  }, [stopNoticeRecording]);

  useEffect(() => {
    if (noticeRecState !== 'recording') return;
    const make = (scale: any, opacity: any, toScale: number, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(scale,   { toValue: toScale, duration: 1400, useNativeDriver: false }),
          Animated.timing(opacity, { toValue: 0,       duration: 1400, useNativeDriver: false }),
        ]),
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1,   duration: 0, useNativeDriver: false }),
          Animated.timing(opacity, { toValue: 0.6, duration: 0, useNativeDriver: false }),
        ]),
      ]));
    const p1 = make(noticePulseScale1, noticePulseOpacity1, 2, 0);
    const p2 = make(noticePulseScale2, noticePulseOpacity2, 1.7, 500);
    p1.start(); p2.start();
    return () => { p1.stop(); p2.stop(); noticePulseScale1.setValue(1); noticePulseScale2.setValue(1); noticePulseOpacity1.setValue(0.6); noticePulseOpacity2.setValue(0.4); };
  }, [noticeRecState]);

  useEffect(() => () => {
    clearNoticeTimers();
    if (noticeRecorder.isRecording) noticeRecorder.stop().catch(() => {});
  }, []);

  async function submitVoiceNotice() {
    if (!noticeTranscript) return;
    // Try to extract exit date from transcript (look for "X days" or dd/mm/yyyy or month name)
    let exitDate = '';
    const daysMatch = noticeTranscript.match(/(\d+)\s*days?/i);
    if (daysMatch) {
      const d = new Date(); d.setDate(d.getDate() + parseInt(daysMatch[1]));
      exitDate = d.toISOString().split('T')[0];
    } else {
      // Default to notice period days
      const d = new Date(); d.setDate(d.getDate() + (config.notice_period_days || 30));
      exitDate = d.toISOString().split('T')[0];
    }

    // We need a tenant selected — open the regular form pre-filled with transcript as notes
    setNForm({ ...blankNotice, notes: noticeTranscript, exitDate });
    setVoiceNoticeOpen(false);
    setNoticeOpen(true);
    setNoticeRecState('idle');
    setNoticeTranscript('');
  }

  async function doNotice() {
    if (!nForm.allotmentId || !nForm.exitDate) return Alert.alert('Validation', 'Select tenant and exit date.');
    await withSave(async () => {
      await client.action((api as any).tenants.createNoticeFull, {
        data: { allotmentId: nForm.allotmentId, tenantId: nForm.tenantId, bedId: nForm.bedId, exitDate: nForm.exitDate, notes: nForm.notes },
      });
      Alert.alert('Success', 'Notice recorded!'); setNoticeOpen(false); setNForm(blankNotice); fetchAll();
    });
  }

  async function doDeleteNotice(notice: any) {
    const allot = allotments.find((a: any) => a.id === notice.allotment_id);
    Alert.alert('Delete Notice', 'Tenant will revert to Staying status.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await withSave(async () => {
          await client.action((api as any).tenants.deleteNoticeFull, {
            noticeId: notice.id, allotmentId: notice.allotment_id,
            bedId: allot?.bed_id || notice.bed_id, tenantId: notice.tenant_id,
          });
          fetchAll();
        });
      }},
    ]);
  }

  async function doUpdateNotice() {
    if (!editNoticeForm.noticeId && !editNoticeForm.allotmentId) return;
    await withSave(async () => {
      await client.action((api as any).tenants.updateNoticeFull, {
        data: { noticeId: editNoticeForm.noticeId, allotmentId: editNoticeForm.allotmentId, noticeDate: editNoticeForm.noticeDate, exitDate: editNoticeForm.exitDate, notes: editNoticeForm.notes },
      });
      Alert.alert('Updated', 'Notice updated.'); setEditNoticeOpen(false); fetchAll();
    });
  }

  async function doExit() {
    const inspectDone = eForm.inspectFurniture && eForm.inspectBed && eForm.inspectWalls && eForm.inspectBathroom;
    if (!eForm.allotmentId || !eForm.exitDate) return Alert.alert('Validation', 'Select tenant and exit date.');
    if (!inspectDone) return Alert.alert('Validation', 'Complete room inspection checklist first.');
    const allot = allotments.find((a: any) => a.id === eForm.allotmentId);
    if (!allot) return;
    const exitDate = new Date(eForm.exitDate);
    const onDate   = allot.onboarding_date ? new Date(allot.onboarding_date) : new Date();
    const stayDays = Math.floor((exitDate.getTime() - onDate.getTime()) / 86400000);
    const under1yr = stayDays < 365;
    const damage   = parseFloat(eForm.damageCharges) || 0;
    const eb       = parseFloat(eForm.ebCharges) || 0;
    const keyLoss  = eForm.keyReturned ? 0 : (config.key_loss_fee || 500);
    const exitChgs = under1yr ? (config.exit_fee_under_1yr || 2250) : 0;
    const pendRent = allot.balance_due || 0;
    const total    = damage + eb + keyLoss + exitChgs + pendRent;
    const advance  = allot.deposit_paid || 0;
    const refund   = advance - total;

    Alert.alert('Confirm Exit', `Refund: ₹${fmtAmt(refund > 0 ? refund : 0)}${refund < 0 ? ` | Owes: ₹${fmtAmt(-refund)}` : ''}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Process Exit', style: 'destructive', onPress: async () => {
        await withSave(async () => {
          await client.action((api as any).tenants.processExitFull, {
            data: {
              allotmentId: eForm.allotmentId, tenantId: eForm.tenantId,
              bedId: eForm.bedId, exitDate: eForm.exitDate,
              hasNotice: eForm.hasNotice, roomInspection: inspectDone,
              keyReturned: eForm.keyReturned, damageCharges: damage,
              keyLossFee: keyLoss, exitCharges: exitChgs, ebCharges: eb,
              pendingRent: pendRent, totalDeductions: total,
              advanceHeld: advance, refundDue: refund,
              notes: eForm.notes,
              // Item 6: revise the exit-month invoice EB ONLY on completion, and only
              // when an invoice already carries an estimated EB.
              reviseEstimatedEb: !!(exitEb && exitEb.estimatedEbIncluded),
              estimatedEbTarget: exitEb ? exitEb.recomputed : 0,
              exitBillingMonth: String(eForm.exitDate).slice(0, 7),
            },
          });
          Alert.alert('Exit Processed', `Refund due: ₹${fmtAmt(Math.max(0, refund))}`);
          setExitOpen(false); setEForm(blankExit); fetchAll();
        });
      }},
    ]);
  }

  async function doUpdateExit() {
    const exitRec = exits.find((e: any) => e.id === editExitForm.exitId);
    if (!exitRec) return;
    const allot = allotments.find((a: any) => a.id === editExitForm.allotmentId);
    const exitDate = new Date(editExitForm.exitDate);
    const onDate   = allot?.onboarding_date ? new Date(allot.onboarding_date) : new Date();
    const under1yr = Math.floor((exitDate.getTime() - onDate.getTime()) / 86400000) < 365;
    const damage  = parseFloat(editExitForm.damageCharges) || 0;
    const keyLoss = editExitForm.keyReturned ? 0 : (config.key_loss_fee || 500);
    const exitChg = under1yr ? (config.exit_fee_under_1yr || 2250) : 0;
    const pendRent= allot?.balance_due || 0;
    const total   = damage + keyLoss + exitChg + pendRent;
    const refund  = (exitRec.advance_held || 0) - total;
    await withSave(async () => {
      await client.action((api as any).tenants.updateExitFull, {
        data: { exitId: editExitForm.exitId, allotmentId: editExitForm.allotmentId, exitDate: editExitForm.exitDate, hasNotice: editExitForm.hasNotice, keyReturned: editExitForm.keyReturned, damageCharges: damage, keyLossFee: keyLoss, exitCharges: exitChg, totalDeductions: total, refundDue: refund, notes: editExitForm.notes },
      });
      setEditExitOpen(false); fetchAll();
    });
  }

  async function doAddPayment() {
    const amt = parseFloat(addPayForm.amount) || 0;
    if (amt <= 0 || !addPayForm.paymentMode) return Alert.alert('Validation', 'Enter amount and payment mode.');
    await withSave(async () => {
      await client.action((api as any).tenants.addLifecyclePayment, {
        data: { allotmentId: addPayForm.allotmentId, amount: amt, paymentMode: addPayForm.paymentMode, referenceNumber: addPayForm.refNo, bankAccountId: addPayForm.bankAccountId || null, ccCharges: parseFloat(addPayForm.ccCharges) || 0 },
      });
      Alert.alert('Success', 'Payment recorded.'); setAddPayOpen(false); fetchAll();
    });
  }

  async function doEditOccupied() {
    await withSave(async () => {
      await client.action((api as any).tenants.updateAllotmentDetails, {
        data: { allotmentId: editOccForm.allotmentId, onboardingDate: editOccForm.onboardingDate, discount: parseFloat(editOccForm.discount) || 0, premium: parseFloat(editOccForm.premium) || 0, depositPaid: parseFloat(editOccForm.depositPaid) || 0 },
      });
      setEditOccOpen(false); fetchAll();
    });
  }

  async function doEditRefund() {
    await withSave(async () => {
      await client.action((api as any).tenants.updateExitRefund, {
        data: { exitId: editRefundForm.exitId, allotmentId: editRefundForm.allotmentId, advanceHeld: editRefundForm.advanceHeld, pendingRent: parseFloat(editRefundForm.pendingRent) || 0, ebCharges: parseFloat(editRefundForm.ebCharges) || 0, exitCharges: parseFloat(editRefundForm.exitCharges) || 0, damageCharges: parseFloat(editRefundForm.damageCharges) || 0, keyLossFee: parseFloat(editRefundForm.keyLossFee) || 0 },
      });
      setEditRefundOpen(false); fetchAll();
    });
  }

  async function doCompleteRefund() {
    const due = Math.round(Number(completeRefundForm.refundDue) || 0);
    // Gate: a payment screenshot must be uploaded, scanned, and its amount must EXACTLY match the refund amount.
    if (!refundProof) return Alert.alert('Payment proof required', `Upload the payment screenshot for this ₹${due} refund.`);
    if (refundProofAmount == null) return Alert.alert('Amount not verified', `Could not read the amount from the screenshot. Upload a clear screenshot showing ₹${due}.`);
    if (refundProofAmount !== due) return Alert.alert('Amount mismatch', `The screenshot shows ₹${refundProofAmount} but the refund amount is ₹${due}. Only a screenshot with the exact refund amount is allowed.`);
    if (!completeRefundForm.referenceNumber) return Alert.alert('Validation', 'Enter reference number.');
    await withSave(async () => {
      await client.action((api as any).tenants.completeRefundFull, {
        data: { exitId: completeRefundForm.exitId, allotmentId: completeRefundForm.allotmentId, tenantId: completeRefundForm.tenantId, refundDate: completeRefundForm.refundDate, referenceNumber: completeRefundForm.referenceNumber, bankAccountId: completeRefundForm.bankAccountId || null },
      });
      Alert.alert('Success', 'Refund completed!'); setCompleteRefundOpen(false); fetchAll();
    });
  }

  // ─── RENDER HELPERS ────────────────────────────────────────────────────────

  const filterBySearch = (items: any[], fields: string[], query: string) => {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((item: any) => fields.some(f => {
      const val = f.split('.').reduce((o, k) => o?.[k], item);
      return val && String(val).toLowerCase().includes(q);
    }));
  };

  const ts = (tab: string) => tabSearch[tab] || '';
  const setTs = (tab: string, v: string) => setTabSearch(prev => ({ ...prev, [tab]: v }));

  function SearchBar({ tab, placeholder }: { tab: string; placeholder?: string }) {
    return (
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.78)', borderRadius: 14,
        borderWidth: 0.5, borderColor: '#EEF1F6',
        paddingHorizontal: 14, height: 46, marginBottom: 14, gap: 10,
        shadowColor: VBRAND.shadow, shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
      }}>
        <Ionicons name="search-outline" size={18} color={VBRAND.ink400} />
        <TextInput value={ts(tab)} onChangeText={v => setTs(tab, v)} placeholder={placeholder || 'Search…'}
          placeholderTextColor={VBRAND.ink400} style={{ flex: 1, fontSize: 14, color: VBRAND.ink900, fontWeight: '500' }} />
        {ts(tab) ? (
          <TouchableOpacity
            onPress={() => setTs(tab, '')}
            style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: VBRAND.purpleSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="close" size={13} color={VBRAND.purple} />
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
      <TouchableOpacity onPress={() => onChange(!checked)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}>
        <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2,
          borderColor: checked ? '#6A2C90' : 'rgba(106,44,144,0.35)', backgroundColor: checked ? '#6A2C90' : 'transparent',
          alignItems: 'center', justifyContent: 'center' }}>
          {checked && <Ionicons name="checkmark" size={14} color="#fff" />}
        </View>
        <Text style={{ fontSize: fontSize.sm, color: '#0F172A' }}>{label}</Text>
      </TouchableOpacity>
    );
  }

  // ─── BED STATUS KPI + FOCUS DETAIL (web default home) ─────────────────────

  function selectBedFocus(key: string) {
    setBedFocus(key);
    setActiveTab(null);
    setBedFocusSearch('');
  }

  function selectModule(key: string) {
    setActiveTab(key);
    setBedFocus(null);
    setBedFocusSearch('');
  }

  function renderBedStatusCard() {
    const totalLive = liveBeds.length;
    const occPct = totalLive > 0
      ? Math.round(((bedCounts.occupied + bedCounts.notice) / totalLive) * 100)
      : 0;
    const counts: Record<string, number> = {
      occupied: bedCounts.occupied,
      booked: bedCounts.booked,
      notice: bedCounts.notice,
      vacant: bedCounts.vacant,
      notbooked: 0,
    };

    return (
      <View style={{
        backgroundColor: '#fff', borderRadius: 18, borderWidth: 1, borderColor: '#EEF1F6',
        padding: 13, marginBottom: 10,
        shadowColor: '#0F172A', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: VBRAND.ink900 }}>Bed Status</Text>
            <Text style={{ fontSize: 11, color: VBRAND.ink500, marginTop: 1 }}>vs previous month</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => Alert.alert('Intelligence', 'Occupancy intelligence coming soon.')}
              style={{
                height: 24, paddingHorizontal: 10, borderRadius: 999,
                borderWidth: 1, borderColor: VBRAND.cardBorder,
                alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff',
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: VBRAND.ink700 }}>Intelligence</Text>
            </TouchableOpacity>
            <View style={{
              height: 24, paddingHorizontal: 10, borderRadius: 999,
              backgroundColor: VBRAND.purpleSoft, alignItems: 'center', justifyContent: 'center',
            }}>
              <Text style={{ fontSize: 11, fontWeight: '800', color: VBRAND.purpleDeep }}>Total {totalLive}</Text>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 10 }}>
          <View style={{
            width: 56, height: 56, borderRadius: 28,
            borderWidth: 5, borderColor: VBRAND.occ,
            alignItems: 'center', justifyContent: 'center', backgroundColor: VBRAND.surfaceSoft,
          }}>
            <Text style={{ fontSize: 13, fontWeight: '800', color: VBRAND.ink900 }}>{totalLive}</Text>
          </View>
          <View style={{ flex: 1, gap: 8 }}>
            <View style={{
              backgroundColor: VBRAND.surfaceSoft, borderRadius: 10, borderWidth: 1,
              borderColor: VBRAND.softLine, padding: 9,
            }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: VBRAND.ink600, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                Current occupancy
              </Text>
              <Text style={{ fontSize: 19, fontWeight: '800', color: VBRAND.ink900, marginTop: 2 }}>{occPct}%</Text>
              <Text style={{ fontSize: 10, color: VBRAND.ink500 }}>(Occupied + Notice) / Total</Text>
            </View>
            <View style={{
              backgroundColor: VBRAND.surfaceSoft, borderRadius: 10, borderWidth: 1,
              borderColor: VBRAND.softLine, padding: 9,
            }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: VBRAND.ink600, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                Month occupancy
              </Text>
              <Text style={{ fontSize: 19, fontWeight: '800', color: VBRAND.ink900, marginTop: 2 }}>{occPct}%</Text>
              <Text style={{ fontSize: 10, color: VBRAND.ink500 }}>{bedCounts.occupied + bedCounts.notice}/{totalLive} beds live</Text>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 5 }}>
          {BED_FOCUS_TILES.map((t) => {
            const on = bedFocus === t.key && !activeTab;
            const val = counts[t.key] ?? 0;
            return (
              <TouchableOpacity
                key={t.key}
                activeOpacity={0.85}
                onPress={() => selectBedFocus(t.key)}
                style={{
                  flex: 1, minWidth: 0,
                  backgroundColor: on ? VBRAND.purpleSoft : VBRAND.surfaceSoft,
                  borderWidth: 1,
                  borderColor: on ? '#E4D3EF' : VBRAND.softLine,
                  borderRadius: 10, paddingVertical: 8, paddingHorizontal: 4, alignItems: 'center',
                }}
              >
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.color, marginBottom: 4 }} />
                <Text style={{ fontSize: 14, fontWeight: '800', color: VBRAND.ink900 }}>{val}</Text>
                <Text style={{ fontSize: 9, fontWeight: '700', color: VBRAND.ink600, textAlign: 'center' }} numberOfLines={1}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  }

  function renderBedFocusDetail() {
    if (!bedFocus) {
      return (
        <View style={{
          backgroundColor: VBRAND.surfaceSoft, borderRadius: 14, borderWidth: 1, borderColor: VBRAND.line,
          padding: 24, alignItems: 'center', marginTop: 4,
        }}>
          <Text style={{ fontSize: 13, color: VBRAND.ink500, textAlign: 'center', fontWeight: '600' }}>
            Pick a Bed Status tile or a Lifecycle module to see details.
          </Text>
        </View>
      );
    }

    const q = bedFocusSearch.trim().toLowerCase();
    const titleMap: Record<string, string> = {
      occupied: 'Occupied',
      booked: 'Booked',
      notice: 'Notice',
      vacant: 'Vacant',
      notbooked: 'Not Booked',
    };
    const title = titleMap[bedFocus] || bedFocus;

    let rows: React.ReactNode[] = [];
    if (bedFocus === 'occupied') {
      const list = stayingAllotments.filter((a: any) => {
        if (!q) return true;
        const name = (a.tenants?.full_name || '').toLowerCase();
        const bed = (bedById[a.bed_id]?.bed_code || '').toLowerCase();
        return name.includes(q) || bed.includes(q);
      });
      rows = list.map((a: any) => {
        const bed = bedById[a.bed_id];
        const apt = bed ? aptById[bed.apartment_id] : null;
        const code = `${apt?.apartment_code || '?'}-${bed?.bed_code || '?'}`;
        return (
          <LifeTenantCard
            key={a.id}
            name={a.tenants?.full_name || 'Tenant'}
            sub={`${code} · Onboarded ${fmtDate(a.onboarding_date || a.start_date)} · Rent ₹${fmtAmt(a.monthly_rent || getBedRate(a.bed_id))}`}
            amount={`₹${fmtAmt(a.advance_amount || a.deposit_amount)}`}
            amountOk
            right={<Ionicons name="chevron-forward" size={16} color={VBRAND.ink400} />}
          />
        );
      });
      if (!rows.length) rows = [<EmptyCard key="e" message={q ? `No Occupied records match "${bedFocusSearch}"` : 'No occupied beds'} />];
    } else if (bedFocus === 'notice') {
      const list = onNotice.filter((a: any) => {
        if (!q) return true;
        return (a.tenants?.full_name || '').toLowerCase().includes(q);
      });
      rows = list.map((a: any) => {
        const bed = bedById[a.bed_id];
        const apt = bed ? aptById[bed.apartment_id] : null;
        const code = `${apt?.apartment_code || '?'}-${bed?.bed_code || '?'}`;
        return (
          <LifeTenantCard
            key={a.id}
            name={a.tenants?.full_name || 'Tenant'}
            pill="On Notice"
            sub={`${code} · ${fmtDate(a.notice_date)} → ${fmtDate(a.exit_date || a.expected_exit_date)}`}
            amount={`₹${fmtAmt(a.monthly_rent || getBedRate(a.bed_id))}`}
          />
        );
      });
      if (!rows.length) rows = [<EmptyCard key="e" message={q ? `No Notice records match "${bedFocusSearch}"` : 'No notice records'} />];
    } else if (bedFocus === 'booked') {
      const list = bookedAllotments.filter((a: any) => {
        if (!q) return true;
        return (a.tenants?.full_name || '').toLowerCase().includes(q);
      });
      rows = list.map((a: any) => {
        const bed = bedById[a.bed_id];
        const apt = bed ? aptById[bed.apartment_id] : null;
        const code = `${apt?.apartment_code || '?'}-${bed?.bed_code || '?'}`;
        const isNew = (a.tenants?.staying_status || '').toLowerCase() === 'new';
        return (
          <LifeTenantCard
            key={a.id}
            name={a.tenants?.full_name || 'Tenant'}
            pill={isNew ? 'New' : undefined}
            sub={`${code} · Booked ${fmtDate(a.booking_date || a.created_at)} · Move-in ${fmtDate(a.expected_move_in || a.start_date)}`}
            amount={`₹${fmtAmt(a.booking_amount || a.advance_amount || config.booking_fee)}`}
          />
        );
      });
      if (!rows.length) rows = [<EmptyCard key="e" message={q ? `No Booked records match "${bedFocusSearch}"` : 'No booked beds'} />];
    } else if (bedFocus === 'vacant') {
      const list = vacantBeds.filter((b: any) => {
        if (!q) return true;
        return `${b._aptCode}-${b.bed_code}`.toLowerCase().includes(q) || (b.bed_type || '').toLowerCase().includes(q);
      });
      rows = list.map((b: any) => (
        <LifeTenantCard
          key={b.id}
          name={`${b._aptCode}-${b.bed_code}`}
          vacant
          sub={`${b.bed_type || '—'} · ${b.toilet_type || '—'}`}
          amount={`₹${fmtAmt(getBedRate(b.id))}`}
          onPress={() => selectModule('map')}
        />
      ));
      if (!rows.length) rows = [<EmptyCard key="e" message={q ? `No Vacant records match "${bedFocusSearch}"` : 'No vacant beds'} />];
    } else {
      rows = [<EmptyCard key="e" message="No Not Booked records" />];
    }

    const countLabel =
      bedFocus === 'occupied' ? stayingAllotments.length
        : bedFocus === 'notice' ? onNotice.length
          : bedFocus === 'booked' ? bookedAllotments.length
            : bedFocus === 'vacant' ? vacantBeds.length
              : 0;

    return (
      <View style={{
        backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: VBRAND.cardBorder,
        padding: 12, marginTop: 2,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: VBRAND.ink900 }}>
            {title} - Detail ({countLabel})
          </Text>
          <TouchableOpacity
            onPress={() => { setBedFocus(null); setBedFocusSearch(''); }}
            style={{
              width: 28, height: 28, borderRadius: 14, backgroundColor: VBRAND.surfaceSoft,
              alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: VBRAND.line,
            }}
          >
            <Ionicons name="close" size={14} color={VBRAND.ink500} />
          </TouchableOpacity>
        </View>
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          backgroundColor: VBRAND.surfaceSoft, borderRadius: 12, borderWidth: 1, borderColor: VBRAND.line,
          paddingHorizontal: 12, height: 42, marginBottom: 10,
        }}>
          <Ionicons name="search-outline" size={16} color={VBRAND.ink400} />
          <TextInput
            value={bedFocusSearch}
            onChangeText={setBedFocusSearch}
            placeholder="Search tenants..."
            placeholderTextColor={VBRAND.ink400}
            style={{ flex: 1, fontSize: 13, color: VBRAND.ink900, fontWeight: '500' }}
          />
          {!!bedFocusSearch && (
            <TouchableOpacity onPress={() => setBedFocusSearch('')}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: VBRAND.purpleDeep }}>Clear search</Text>
            </TouchableOpacity>
          )}
        </View>
        {rows}
      </View>
    );
  }

  // ─── TAB: DASHBOARD (legacy fallback — unused; Bed Status replaces it) ─────

  function renderDashboard() {
    return renderBedFocusDetail();
  }

  // ─── TAB: BED MAP ──────────────────────────────────────────────────────────

  function renderBedMap() {
    const STATUS_FILTERS = [
      { key: null,            label: 'All',           color: '#6A2C90' },
      { key: 'occupied',      label: 'Occupied',      color: '#16A34A' },
      { key: 'vacant',        label: 'Vacant',        color: '#DC2626' },
      { key: 'notice',        label: 'Notice',        color: '#EA580C' },
      { key: 'booked',        label: 'Booked',        color: '#1D4ED8' },
      { key: 'notice-booked', label: 'Notice-Booked', color: '#6A2C90' },
    ];

    const BED_STATUS_COLORS: Record<string, { bg: string; border: string; textColor: string; dot: string }> = {
      occupied:        { bg: '#DCFCE7', border: '#16A34A', textColor: '#15803D', dot: '#16A34A' },
      vacant:          { bg: '#FEE2E2', border: '#DC2626', textColor: '#B91C1C', dot: '#DC2626' },
      notice:          { bg: '#FFEDD5', border: '#EA580C', textColor: '#C2410C', dot: '#EA580C' },
      booked:          { bg: '#EEF3FF', border: '#1D4ED8', textColor: '#1D4ED8', dot: '#1D4ED8' },
      'notice-booked': { bg: '#EDE9FE', border: '#6A2C90', textColor: '#6A2C90', dot: '#6A2C90' },
    };

    // ── summary counts ────────────────────────────────────────────────────────
    const totalBeds = liveBeds.length;
    const countByStatus = liveBeds.reduce((acc: any, bed: any) => {
      const s = getBedStatusFromAllotments(bed.id);
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const occupancyPct = totalBeds > 0 ? Math.round((((countByStatus['occupied'] || 0) + (countByStatus['notice'] || 0) + (countByStatus['notice-booked'] || 0)) / totalBeds) * 100) : 0;

    // ── group by property → apartment ─────────────────────────────────────────
    const grouped: Record<string, { property: any; apartments: Record<string, { apartment: any; beds: any[] }> }> = {};
    liveBeds.forEach((bed: any) => {
      const status = getBedStatusFromAllotments(bed.id);
      if (mapFilter && status !== mapFilter) return;
      const apt = aptById[bed.apartment_id];
      if (!apt) return;
      if (mapSearch) {
        const q = mapSearch.toLowerCase();
        const allot = allotments.find((a: any) => a.bed_id === bed.id && ['Staying','On-Notice','Booked'].includes(a.staying_status));
        const tName = allot?.tenants?.full_name || '';
        if (!bed.bed_code?.toLowerCase().includes(q) && !apt.apartment_code?.toLowerCase().includes(q) && !tName.toLowerCase().includes(q)) return;
      }
      const prop = propById[apt.property_id];
      const propId = apt.property_id || 'unknown';
      if (!grouped[propId]) grouped[propId] = { property: prop, apartments: {} };
      if (!grouped[propId].apartments[apt.id]) grouped[propId].apartments[apt.id] = { apartment: apt, beds: [] };
      grouped[propId].apartments[apt.id].beds.push({ ...bed, _status: status, _apt: apt });
    });

    return (
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* ── Occupancy summary bar ─────────────────────────────────────────── */}
        <Card style={{ marginBottom: 10, padding: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#0F172A' }}>Occupancy</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#6A2C90' }}>{occupancyPct}%  ({countByStatus['occupied'] || 0}/{totalBeds})</Text>
              {/* ── CSV export for bed map ─────────────────────────────────── */}
              <TouchableOpacity
                onPress={async () => {
                  try {
                    if (liveBeds.length === 0) { Alert.alert('No Data', 'No beds to export.'); return; }
                    const header = ['Property', 'Apartment', 'Bed Code', 'Bed Type', 'Toilet', 'Status', 'Rate (₹/mo)', 'Tenant', 'Phone'].join(',');
                    const rows = liveBeds.map((bed: any) => {
                      const apt  = aptById[bed.apartment_id]  || {};
                      const prop = propById[apt.property_id]  || {};
                      const status = getBedStatusFromAllotments(bed.id);
                      const rate = getBedRate(bed.id);
                      const allot = allotments.find((a: any) => a.bed_id === bed.id && ['Staying','On-Notice','Booked'].includes(a.staying_status));
                      const esc = (v: string) => `"${String(v || '').replace(/"/g, '""')}"`;
                      return [
                        esc(prop.property_name || '—'),
                        esc(apt.apartment_code  || '—'),
                        esc(bed.bed_code        || '—'),
                        esc(bed.bed_type        || '—'),
                        esc(bed.toilet_type     || '—'),
                        esc(status),
                        String(rate),
                        esc(allot?.tenants?.full_name || '—'),
                        esc(allot?.tenants?.phone     || '—'),
                      ].join(',');
                    });
                    const csvContent = [header, ...rows].join('\n');
                    const filename = `beds-${new Date().toISOString().split('T')[0]}.csv`;
                    const FileSystem = await import('expo-file-system') as any;
                    const fileUri = FileSystem.cacheDirectory + filename;
                    await FileSystem.writeAsStringAsync(fileUri, csvContent, { encoding: 'utf8' });
                    const Sharing = await import('expo-sharing') as any;
                    const canShare = await Sharing.isAvailableAsync();
                    if (canShare) {
                      await Sharing.shareAsync(fileUri, {
                        mimeType: 'text/csv',
                        dialogTitle: 'Export Bed Map',
                        UTI: 'public.comma-separated-values-text',
                      });
                    } else {
                      Alert.alert('Sharing not available', 'Cannot share files on this device.');
                    }
                  } catch (e: any) {
                    Alert.alert('Export failed', e?.message || 'Could not export bed map.');
                  }
                }}
                style={{
                  width: 30, height: 30, borderRadius: 99,
                  backgroundColor: 'rgba(106,44,144,0.10)',
                  alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Ionicons name="download-outline" size={16} color="#6A2C90" />
              </TouchableOpacity>
            </View>
          </View>
          {/* Progress bar */}
          <View style={{ height: 6, backgroundColor: '#F3ECF9', borderRadius: 99, overflow: 'hidden', marginBottom: 10 }}>
            <View style={{ height: 6, width: `${occupancyPct}%` as any, backgroundColor: '#6A2C90', borderRadius: 99 }} />
          </View>
          {/* Stat pills */}
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {[
              { label: 'Occupied',  count: countByStatus['occupied']      || 0, color: '#16A34A', bg: '#DCFCE7' },
              { label: 'Vacant',    count: countByStatus['vacant']        || 0, color: '#DC2626', bg: '#FEE2E2' },
              { label: 'Booked',    count: (countByStatus['booked'] || 0) + (countByStatus['notice-booked'] || 0), color: '#1D4ED8', bg: '#EEF3FF' },
              { label: 'Notice',    count: (countByStatus['notice'] || 0) + (countByStatus['notice-booked'] || 0), color: '#EA580C', bg: '#FFEDD5' },
            ].map(s => (
              <View key={s.label} style={{ backgroundColor: s.bg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 99, backgroundColor: s.color }} />
                <Text style={{ fontSize: 11, fontWeight: '700', color: s.color }}>{s.count} {s.label}</Text>
              </View>
            ))}
          </View>
        </Card>

        {/* ── Search ───────────────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(229,231,235,0.9)', paddingHorizontal: 12, height: 42, marginBottom: 10 }}>
          <Ionicons name="search-outline" size={16} color="#64748B" />
          <TextInput value={mapSearch} onChangeText={setMapSearch} placeholder="Search tenant or bed…" placeholderTextColor="#64748B" style={{ flex: 1, marginLeft: 8, fontSize: fontSize.sm, color: '#0F172A' }} />
          {mapSearch.length > 0 && (
            <TouchableOpacity onPress={() => setMapSearch('')}>
              <Ionicons name="close-circle" size={16} color="#64748B" />
            </TouchableOpacity>
          )}
        </View>

        {/* ── Status filter chips ───────────────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 7 }}>
            {STATUS_FILTERS.map(f => (
              <TouchableOpacity key={String(f.key)} onPress={() => setMapFilter(f.key)}
                style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 99, borderWidth: 1.5,
                  borderColor: f.color, backgroundColor: mapFilter === f.key ? f.color : 'rgba(255,255,255,0.7)' }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: mapFilter === f.key ? '#fff' : f.color }}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* ── Legend ───────────────────────────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 2 }}>
            {[
              { label: 'Occupied', dot: '#16A34A' },
              { label: 'Vacant',   dot: '#DC2626' },
              { label: 'Notice',   dot: '#EA580C' },
              { label: 'Booked',   dot: '#1D4ED8' },
              { label: 'N+Book',   dot: '#6A2C90' },
            ].map(l => (
              <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: l.dot }} />
                <Text style={{ fontSize: 10, color: '#556274', fontWeight: '600' }}>{l.label}</Text>
              </View>
            ))}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ fontSize: 10, color: '#64748B' }}>  S=Single D=Double T=Triple  A=Attached C=Common</Text>
            </View>
          </View>
        </ScrollView>

        {/* ── Sort toggle: Apartment / Gender ──────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#64748B' }}>SORT</Text>
          <View style={{ flexDirection: 'row', backgroundColor: 'rgba(237,233,245,0.7)', borderRadius: 99, padding: 3 }}>
            {([
              { key: 'apartment', label: 'Apartment', icon: 'business-outline' },
              { key: 'gender',    label: 'Gender',    icon: 'people-outline' },
            ] as const).map(opt => {
              const active = mapSortBy === opt.key;
              return (
                <TouchableOpacity key={opt.key} onPress={() => setMapSortBy(opt.key)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 99,
                    backgroundColor: active ? '#6A2C90' : 'transparent' }}>
                  <Ionicons name={opt.icon as any} size={12} color={active ? '#fff' : '#6A2C90'} />
                  <Text style={{ fontSize: 11, fontWeight: '700', color: active ? '#fff' : '#6A2C90' }}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── Gender legend (shown when sorting by gender) ─────────────────── */}
        {mapSortBy === 'gender' && (
          <View style={{ flexDirection: 'row', gap: 14, marginBottom: 10, paddingHorizontal: 2 }}>
            {[
              { label: '♂ Male',   accent: '#1D4ED8', bg: '#BBDEFB' },
              { label: '♀ Female', accent: '#C2185B', bg: '#FCE4EC' },
              { label: '⚥ Mixed',  accent: '#6A2C90', bg: '#F3ECF9' },
            ].map(g => (
              <View key={g.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: g.bg, borderWidth: 1.5, borderColor: `${g.accent}55` }} />
                <Text style={{ fontSize: 10, fontWeight: '700', color: g.accent }}>{g.label}</Text>
              </View>
            ))}
          </View>
        )}

        {/* ── Property → Apartment → Bed grid ──────────────────────────────── */}
        {Object.entries(grouped).map(([propId, propGroup]) => (
          <View key={propId} style={{ marginBottom: 14 }}>

            {/* Property header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(106,44,144,0.12)' }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#F3ECF9', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 4 }}>
                <Ionicons name="business-outline" size={11} color="#6A2C90" />
                <Text style={{ fontSize: 11, fontWeight: '800', color: '#6A2C90', letterSpacing: 0.5 }}>
                  {propGroup.property?.property_name || 'Property'}
                </Text>
              </View>
              <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(106,44,144,0.12)' }} />
            </View>

            {/* Apartments */}
            {Object.entries(propGroup.apartments)
              .sort(([,a]: any, [,b]: any) => {
                if (mapSortBy === 'gender') {
                  const gA = (a.apartment?.gender_allowed || '').toLowerCase();
                  const gB = (b.apartment?.gender_allowed || '').toLowerCase();
                  const cmp = gA.localeCompare(gB);
                  if (cmp !== 0) return cmp;
                }
                return (a.apartment.apartment_code || '').localeCompare(b.apartment.apartment_code || '');
              })
              .map(([aptId, aptGroup]: any) => {
                const gender = (aptGroup.apartment?.gender_allowed || '').toLowerCase();
                const isMale = gender === 'male';
                const isFemale = gender === 'female';
                const aptAccent = isMale ? '#1D4ED8' : isFemale ? '#C2185B' : '#6A2C90';
                const aptBg = isMale ? '#F0F7FF' : isFemale ? '#FFF0F5' : '#F8FAFC';
                const aptHeaderBg = isMale ? '#BBDEFB' : isFemale ? '#FCE4EC' : '#F3ECF9';

                const aptBedCount = aptGroup.beds.length;
                const aptOccupied = aptGroup.beds.filter((b: any) => b._status === 'occupied').length;
                const aptVacant = aptGroup.beds.filter((b: any) => b._status === 'vacant').length;

                return (
                  <View key={aptId} style={{ marginBottom: 8, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: `${aptAccent}22`, backgroundColor: aptBg,
                    shadowColor: aptAccent, shadowOpacity: 0.07, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}>

                    {/* Apartment header row */}
                    <View style={{ backgroundColor: aptHeaderBg, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: `${aptAccent}18`, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: `${aptAccent}33` }}>
                          <Text style={{ fontSize: 12, fontWeight: '900', color: aptAccent }}>{aptGroup.apartment?.apartment_code || '?'}</Text>
                        </View>
                        <View>
                          <Text style={{ fontSize: 12, fontWeight: '800', color: '#0F172A' }}>
                            {aptGroup.apartment?.apartment_code || 'Unknown Apt'}
                          </Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Text style={{ fontSize: 9, color: aptAccent, fontWeight: '700' }}>
                              {isMale ? '♂ Male' : isFemale ? '♀ Female' : '⚥ Mixed'}
                            </Text>
                            <Text style={{ fontSize: 9, color: '#64748B' }}>· {aptBedCount} beds</Text>
                          </View>
                        </View>
                      </View>
                      {/* Mini occupancy */}
                      <View style={{ alignItems: 'flex-end', gap: 2 }}>
                        <View style={{ flexDirection: 'row', gap: 5 }}>
                          <View style={{ backgroundColor: '#DCFCE7', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>{aptOccupied} occ</Text>
                          </View>
                          <View style={{ backgroundColor: '#FEE2E2', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: '#DC2626' }}>{aptVacant} vac</Text>
                          </View>
                        </View>
                        {/* Mini bar */}
                        <View style={{ width: 60, height: 4, backgroundColor: '#F3ECF9', borderRadius: 99, overflow: 'hidden' }}>
                          <View style={{ height: 4, width: aptBedCount > 0 ? `${Math.round((aptOccupied / aptBedCount) * 100)}%` as any : '0%', backgroundColor: aptAccent, borderRadius: 99 }} />
                        </View>
                      </View>
                    </View>

                    {/* Beds grid */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 10, gap: 8 }}>
                      {aptGroup.beds
                        .sort((a: any, b: any) => (a.bed_code || '').localeCompare(b.bed_code || ''))
                        .map((bed: any) => {
                          const sc = BED_STATUS_COLORS[bed._status] || BED_STATUS_COLORS.vacant;
                          const allot = allotments.find((a: any) => a.bed_id === bed.id && ['Staying','On-Notice','Booked'].includes(a.staying_status));
                          const firstName = allot?.tenants?.full_name?.split(' ')[0] || '';
                          const bedTypeShort = ({ Single: 'S', Double: 'D', Triple: 'T', Executive: 'E', Quad: 'Q' } as any)[bed.bed_type] || bed.bed_type?.charAt(0) || '?';
                          const toiletShort = (bed.toilet_type || '').toLowerCase() === 'attached' ? 'A' : 'C';
                          const rate = getBedRate(bed.id);
                          return (
                            <TouchableOpacity
                              key={bed.id}
                              onPress={() => setBedDetail({ ...bed, allotment: allot, status: bed._status, _apt: aptGroup.apartment })}
                              style={{
                                width: 70, borderRadius: 11, borderWidth: 1.5, borderColor: sc.border,
                                backgroundColor: sc.bg, padding: 8, alignItems: 'flex-start',
                                shadowColor: sc.border, shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 1,
                              }}>
                              {/* Status dot */}
                              <View style={{ position: 'absolute', top: 7, right: 7, width: 7, height: 7, borderRadius: 99, backgroundColor: sc.dot }} />
                              {/* Bed code */}
                              <Text style={{ fontSize: 11, fontWeight: '900', color: sc.textColor, marginBottom: 2 }}>{bed.bed_code}</Text>
                              {/* Type + toilet badge */}
                              <View style={{ flexDirection: 'row', gap: 3, marginBottom: 3 }}>
                                <View style={{ backgroundColor: `${sc.border}22`, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 }}>
                                  <Text style={{ fontSize: 8, fontWeight: '700', color: sc.textColor }}>{bedTypeShort}</Text>
                                </View>
                                <View style={{ backgroundColor: toiletShort === 'A' ? '#DCFCE7' : '#FFEDD5', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 }}>
                                  <Text style={{ fontSize: 8, fontWeight: '700', color: toiletShort === 'A' ? '#16A34A' : '#EA580C' }}>{toiletShort}</Text>
                                </View>
                              </View>
                              {/* Rate */}
                              {rate > 0 && (
                                <Text style={{ fontSize: 8, color: '#6A2C90', fontWeight: '700' }}>₹{fmtAmt(rate)}</Text>
                              )}
                              {/* Tenant name */}
                              {firstName
                                ? <Text style={{ fontSize: 9, fontWeight: '700', color: sc.textColor, marginTop: 2 }} numberOfLines={1}>{firstName}</Text>
                                : <Text style={{ fontSize: 9, color: '#94A3B8', marginTop: 2 }}>Empty</Text>}
                            </TouchableOpacity>
                          );
                        })}
                    </View>
                  </View>
                );
              })}
          </View>
        ))}

        {Object.keys(grouped).length === 0 && (
          <Card style={{ alignItems: 'center', paddingVertical: 36 }}>
            <Ionicons name="bed-outline" size={40} color="#94A3B8" />
            <Text style={{ color: '#64748B', fontSize: fontSize.sm, marginTop: 10, fontWeight: '600' }}>No beds match your filters</Text>
            {(mapFilter || mapSearch) && (
              <TouchableOpacity onPress={() => { setMapFilter(null); setMapSearch(''); }}
                style={{ marginTop: 10, backgroundColor: '#F3ECF9', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 6 }}>
                <Text style={{ fontSize: 12, color: '#6A2C90', fontWeight: '700' }}>Clear filters</Text>
              </TouchableOpacity>
            )}
          </Card>
        )}

        {/* ── Bed detail bottom-sheet modal ──────────────────────────────────── */}
        {bedDetail && (() => {
          const sc = BED_STATUS_COLORS[bedDetail.status] || BED_STATUS_COLORS.vacant;
          const rate = getBedRate(bedDetail.id);
          const bedTypeLabel = bedDetail.bed_type || '—';
          const toiletLabel = bedDetail.toilet_type || '—';
          const isAttached = (bedDetail.toilet_type || '').toLowerCase() === 'attached';

          // All rates for this bed type + toilet type
          const allRatesForBed = bedRates
            .filter((r: any) => r.bed_type === bedDetail.bed_type && r.toilet_type === bedDetail.toilet_type)
            .sort((a: any, b: any) => b.from_date.localeCompare(a.from_date))
            .slice(0, 3);

          return (
            <Modal visible transparent animationType="slide" onRequestClose={() => setBedDetail(null)}>
              <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
                activeOpacity={1} onPress={() => setBedDetail(null)}>
                <TouchableOpacity activeOpacity={1} onPress={() => {}}>
                  <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 32, overflow: 'hidden' }}>

                    {/* Handle bar */}
                    <View style={{ alignItems: 'center', paddingTop: 12, marginBottom: 4 }}>
                      <View style={{ width: 40, height: 4, borderRadius: 99, backgroundColor: '#E2E8F0' }} />
                    </View>

                    {/* Header */}
                    <View style={{ backgroundColor: sc.bg, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: `${sc.border}33` }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${sc.border}22`, borderWidth: 2, borderColor: sc.border, alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="bed-outline" size={22} color={sc.textColor} />
                          </View>
                          <View>
                            <Text style={{ fontSize: 20, fontWeight: '900', color: sc.textColor }}>
                              {bedDetail._apt?.apartment_code}-{bedDetail.bed_code}
                            </Text>
                            <Text style={{ fontSize: 12, color: sc.textColor, opacity: 0.7, fontWeight: '600' }}>
                              {bedDetail._apt?.apartment_code || '—'}
                            </Text>
                          </View>
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <StatusPill status={bedDetail.status} />
                          <TouchableOpacity onPress={() => setBedDetail(null)}>
                            <Ionicons name="close-circle" size={22} color={sc.textColor} style={{ opacity: 0.6 }} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>

                    <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
                      <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 12 }}>

                        {/* Bed specs */}
                        <View>
                          <SectionTitle title="Bed Details" />
                          <View style={{ flexDirection: 'row', gap: 10 }}>
                            {/* Bed type card */}
                            <View style={{ flex: 1, backgroundColor: '#F8FAFC', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#F3ECF9', alignItems: 'center', gap: 4 }}>
                              <Ionicons name="bed-outline" size={22} color="#6A2C90" />
                              <Text style={{ fontSize: 13, fontWeight: '800', color: '#0F172A' }}>{bedTypeLabel}</Text>
                              <Text style={{ fontSize: 10, color: '#64748B', fontWeight: '600' }}>Bed Type</Text>
                            </View>
                            {/* Toilet type card */}
                            <View style={{ flex: 1, backgroundColor: isAttached ? '#DCFCE7' : '#FFEDD5', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: isAttached ? '#C8E6C9' : '#FFE0B2', alignItems: 'center', gap: 4 }}>
                              <Ionicons name={isAttached ? 'water-outline' : 'people-outline'} size={22} color={isAttached ? '#16A34A' : '#EA580C'} />
                              <Text style={{ fontSize: 13, fontWeight: '800', color: isAttached ? '#16A34A' : '#EA580C' }}>{toiletLabel}</Text>
                              <Text style={{ fontSize: 10, color: '#64748B', fontWeight: '600' }}>Toilet</Text>
                            </View>
                            {/* Rate card */}
                            <View style={{ flex: 1, backgroundColor: '#F3ECF9', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#DBEAFE', alignItems: 'center', gap: 4 }}>
                              <Ionicons name="pricetag-outline" size={22} color="#6A2C90" />
                              <Text style={{ fontSize: 13, fontWeight: '800', color: '#6A2C90' }}>₹{fmtAmt(rate)}</Text>
                              <Text style={{ fontSize: 10, color: '#64748B', fontWeight: '600' }}>/ month</Text>
                            </View>
                          </View>
                        </View>

                        {/* Rate history */}
                        {allRatesForBed.length > 0 && (
                          <View>
                            <SectionTitle title="Rate History" />
                            <View style={{ backgroundColor: '#F8FAFC', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#F3ECF9' }}>
                              {allRatesForBed.map((r: any, i: number) => {
                                const isCurrent = r.from_date <= today() && (!r.to_date || r.to_date >= today());
                                return (
                                  <View key={r.id || i} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                                    paddingHorizontal: 14, paddingVertical: 10,
                                    borderTopWidth: i > 0 ? 1 : 0, borderTopColor: '#F3ECF9',
                                    backgroundColor: isCurrent ? '#F3ECF9' : 'transparent' }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                      {isCurrent && <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: '#6A2C90' }} />}
                                      <View>
                                        <Text style={{ fontSize: 12, fontWeight: '700', color: isCurrent ? '#6A2C90' : '#0F172A' }}>
                                          ₹{fmtAmt(r.monthly_rate)}/mo
                                        </Text>
                                        <Text style={{ fontSize: 10, color: '#64748B' }}>
                                          {fmtDate(r.from_date)}{r.to_date ? ` → ${fmtDate(r.to_date)}` : ' → present'}
                                        </Text>
                                      </View>
                                    </View>
                                    {isCurrent && (
                                      <View style={{ backgroundColor: '#6A2C90', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                                        <Text style={{ fontSize: 9, fontWeight: '800', color: '#fff' }}>CURRENT</Text>
                                      </View>
                                    )}
                                  </View>
                                );
                              })}
                            </View>
                          </View>
                        )}

                        {/* Tenant info */}
                        {bedDetail.allotment ? (
                          <View>
                            <SectionTitle title="Current Tenant" />
                            <View style={{ backgroundColor: '#F8FAFC', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#F3ECF9' }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                                <View style={{ width: 42, height: 42, borderRadius: 99, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                                  <Ionicons name="person-outline" size={20} color="#6A2C90" />
                                </View>
                                <View>
                                  <Text style={{ fontSize: 15, fontWeight: '800', color: '#0F172A' }}>{bedDetail.allotment.tenants?.full_name || '—'}</Text>
                                  <Text style={{ fontSize: 12, color: '#64748B' }}>{bedDetail.allotment.tenants?.phone || '—'}</Text>
                                </View>
                              </View>
                              <Divider />
                              <Row label="Move-in Date" value={fmtDate(bedDetail.allotment.onboarding_date)} />
                              <Row label="Monthly Rent" value={`₹${fmtAmt(bedDetail.allotment.monthly_rental)}/mo`} />
                              <Row label="Deposit Paid" value={`₹${fmtAmt(bedDetail.allotment.deposit_paid)}`} />
                              {bedDetail.allotment.discount > 0 && <Row label="Discount" value={`₹${fmtAmt(bedDetail.allotment.discount)}/mo`} valueColor="#EA580C" />}
                              {bedDetail.status === 'notice' && <Row label="Est. Exit" value={fmtDate(bedDetail.allotment.estimated_exit_date)} valueColor="#EA580C" />}
                              {bedDetail.status === 'notice' && (
                                <View style={{ marginTop: 8, backgroundColor: '#FFEDD5', borderRadius: 8, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                  <Ionicons name="warning-outline" size={14} color="#EA580C" />
                                  <Text style={{ fontSize: 11, color: '#EA580C', fontWeight: '600' }}>Tenant has served notice</Text>
                                </View>
                              )}
                            </View>
                          </View>
                        ) : (
                          <View style={{ backgroundColor: '#FEE2E2', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#FFCDD2', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <Ionicons name="bed-outline" size={22} color="#DC2626" />
                            <View>
                              <Text style={{ fontSize: 14, fontWeight: '700', color: '#DC2626' }}>Bed is Vacant</Text>
                              <Text style={{ fontSize: 12, color: '#E57373' }}>Available for booking at ₹{fmtAmt(rate)}/mo</Text>
                            </View>
                          </View>
                        )}

                      </View>
                    </ScrollView>
                  </View>
                </TouchableOpacity>
              </TouchableOpacity>
            </Modal>
          );
        })()}
      </ScrollView>
    );
  }

  // ─── TAB: BOOKING ──────────────────────────────────────────────────────────

  function renderBooking() {
    const allBeds = [...vacantBeds, ...noticeBeds];
    const bedOptions = allBeds.map((b: any) => ({ label: `${b._aptCode}-${b.bed_code} (${b.bed_type}) — ₹${fmtAmt(getBedRate(b.id))}/mo`, value: b.id }));
    const tenantOptions = [
      ...eligibleTenants.map((t: any) => ({ label: `${t.full_name} · ${t.phone}`, value: t.id })),
      ...returningTenants.map((t: any) => ({ label: `↩ ${t.full_name} · ${t.phone}`, value: t.id })),
    ];
    const filtered = filterBySearch(bookedAllotments, ['tenants.full_name', 'apartments.apartment_code'], ts('booking'));
    const openBookingFor = (tenantId: string) => { setBForm({ ...bForm, tenantId }); setBookingOpen(true); };
    const BookBtn = ({ onPress }: { onPress: () => void }) => (
      <TouchableOpacity onPress={onPress} activeOpacity={0.85}
        style={{ backgroundColor: VBRAND.purpleSoft, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 }}>
        <Text style={{ fontSize: 12, fontWeight: '800', color: VBRAND.purpleDeep }}>Book</Text>
      </TouchableOpacity>
    );
    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* ── Section 1: New Tenants (KYC ✓) ──────────────────────────────── */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <SectionTitle title={`New Tenants (KYC ✓)`} />
          <ActionBtn title="New Booking" icon="add-circle-outline" small onPress={() => setBookingOpen(true)} />
        </View>
        {eligibleTenants.length === 0
          ? <EmptyCard message="No new tenants with completed KYC" />
          : eligibleTenants.map((t: any) => (
              <LifeTenantCard
                key={t.id}
                name={t.full_name || '—'}
                sub={t.phone}
                pill="New"
                right={<BookBtn onPress={() => openBookingFor(t.id)} />}
              />
            ))
        }

        {/* ── Section 2: Returning Tenants (Previously Exited) ─────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, marginBottom: 8 }}>
          <Ionicons name="refresh-outline" size={15} color={VBRAND.ink600} />
          <Text style={{ fontSize: 13, fontWeight: '700', color: VBRAND.ink600 }}>Returning Tenants (Previously Exited)</Text>
        </View>
        {returningTenants.length === 0
          ? <Text style={{ fontSize: 12, color: VBRAND.ink500, paddingVertical: 8, paddingLeft: 2 }}>No returning tenants</Text>
          : returningTenants.map((t: any) => (
              <LifeTenantCard
                key={t.id}
                name={t.full_name || '—'}
                sub={t.phone}
                pill={typeof t.tenant_rating === 'number' ? `★ ${t.tenant_rating.toFixed(1)}` : undefined}
                right={<BookBtn onPress={() => openBookingFor(t.id)} />}
              />
            ))
        }

        {/* ── Section 3: Booked — Pending Onboarding ───────────────────────── */}
        <View style={{ marginTop: 18, marginBottom: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: VBRAND.ink600 }}>Booked — Pending Onboarding</Text>
        </View>
        <SearchBar tab="booking" placeholder="Search tenant, bed…" />
        {filtered.length === 0 ? <EmptyCard message="No booked tenants" /> :
          filtered.map((a: any) => (
            <Card key={a.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm, color: '#0F172A' }}>{a.tenants?.full_name}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginTop: 2 }}>{a.apartments?.apartment_code}-{a.beds?.bed_code}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#6A2C90', fontWeight: '600' }}>Paid: ₹{fmtAmt(a.paid_amount || a.deposit_paid)}</Text>
                </View>
                <TouchableOpacity onPress={() => { setCancelId(a.id); setCancelOpen(true); }}
                  style={{ backgroundColor: '#FEE2E2', borderRadius: 8, padding: 8 }}>
                  <Ionicons name="close-circle-outline" size={18} color="#DC2626" />
                </TouchableOpacity>
              </View>
            </Card>
          ))
        }

        {/* Booking form */}
        <BottomSheet visible={bookingOpen} onClose={() => setBookingOpen(false)} title="New Booking">
          <Field label="Tenant *">
            <SelectF options={tenantOptions} value={bForm.tenantId} onChange={v => setBForm({ ...bForm, tenantId: v })} placeholder="Select tenant…" />
          </Field>
          <Field label="Bed *">
            <SelectF options={bedOptions} value={bForm.bedId} onChange={v => setBForm({ ...bForm, bedId: v })} placeholder="Select bed…" />
          </Field>
          {bForm.bedId && (
            <Card style={{ marginBottom: 14 }}>
              <Row label="Bed Rate" value={`₹${fmtAmt(getBedRate(bForm.bedId))}/mo`} />
            </Card>
          )}
          <Field label="Planned Onboarding Date *"><DateF value={bForm.onboardingDate} onChange={v => setBForm({ ...bForm, onboardingDate: v })} /></Field>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Discount (₹)"><TextF value={bForm.discount} onChange={v => setBForm({ ...bForm, discount: v })} keyboardType="numeric" /></Field></View>
            <View style={{ flex: 1 }}><Field label="Premium (₹)"><TextF value={bForm.premium} onChange={v => setBForm({ ...bForm, premium: v })} keyboardType="numeric" /></Field></View>
          </View>
          {/* ── Payment Proof (gallery or camera) — upload first; scan auto-fills amount / ref / bank ─── */}
          <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="receipt-outline" size={14} color="#6A2C90" />
                <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#6A2C90', letterSpacing: 1, textTransform: 'uppercase' }}>
                  Payment Proof
                </Text>
                <View style={{ backgroundColor: '#F3ECF9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 9, color: '#64748B', fontWeight: '600' }}>Optional</Text>
                </View>
              </View>
              {proofScanning.booking && (
                <Text style={{ fontSize: 10, color: '#6A2C90', fontWeight: '700' }}>Scanning receipt…</Text>
              )}
              {bookingProof && !proofScanning.booking && (
                <TouchableOpacity onPress={() => setBookingProof(null)}>
                  <Text style={{ fontSize: fontSize.xs, color: '#DC2626', fontWeight: '700' }}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity
              onPress={() => pickProof('booking')}
              style={{
                height: bookingProof ? 160 : 80,
                borderRadius: 14, borderWidth: 1.5,
                borderStyle: bookingProof ? 'solid' : 'dashed',
                borderColor: bookingProof ? '#6A2C90' : '#EEF1F6',
                backgroundColor: bookingProof ? '#F3ECF9' : 'rgba(106,44,144,0.04)',
                alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {bookingProof ? (
                <>
                  <Image source={{ uri: bookingProof.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(106,44,144,0.75)', paddingVertical: 5, alignItems: 'center' }}>
                    <Text style={{ fontSize: 11, color: '#fff', fontWeight: '700' }}>Tap to change</Text>
                  </View>
                </>
              ) : (
                <View style={{ alignItems: 'center', gap: 6 }}>
                  <View style={{ flexDirection: 'row', gap: 16 }}>
                    <View style={{ alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 99, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="image-outline" size={18} color="#6A2C90" />
                      </View>
                      <Text style={{ fontSize: 10, color: '#556274', fontWeight: '600' }}>Gallery</Text>
                    </View>
                    <View style={{ alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 99, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="camera-outline" size={18} color="#6A2C90" />
                      </View>
                      <Text style={{ fontSize: 10, color: '#556274', fontWeight: '600' }}>Camera</Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 10, color: '#64748B' }}>Upload receipt / screenshot</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Booking Amount (₹)"><TextF value={bForm.amount} onChange={v => setBForm({ ...bForm, amount: v })} keyboardType="numeric" placeholder={String(config.booking_fee || 1000)} /></Field></View>
            <View style={{ flex: 1 }}><Field label="Payment Mode *"><SelectF options={PAY_MODES} value={bForm.paymentMode} onChange={v => setBForm({ ...bForm, paymentMode: v })} /></Field></View>
          </View>
          <Field label="Transaction Reference"><TextF value={bForm.refNo} onChange={v => setBForm({ ...bForm, refNo: v })} placeholder="UTR/Ref no." /></Field>

          {/* ── Bank Details (mirrors web app) ─────────────────────────────── */}
          <Field label="Bank Details">
            {bankAccountOptions.length === 0
              ? <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginTop: 4 }}>No bank accounts found. Add one under Accounting → Bank Accounts.</Text>
              : <SelectF options={[{ label: '— Select bank account —', value: '' }, ...bankAccountOptions]} value={bForm.bankAccountId} onChange={v => setBForm({ ...bForm, bankAccountId: v })} placeholder="Select organisation bank account" />
            }
          </Field>

          <ActionBtn title="Confirm Booking" onPress={doCreateBooking} loading={saving || proofUploading} />
        </BottomSheet>

        {/* Cancel confirm */}
        <BottomSheet visible={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel Booking">
          <Text style={{ fontSize: fontSize.sm, color: '#556274', marginBottom: 20, lineHeight: 22 }}>
            Cancel the booking for{' '}
            <Text style={{ fontWeight: '700', color: '#0F172A' }}>
              {allotments.find((a: any) => a.id === cancelId)?.tenants?.full_name}
            </Text>? This will free the bed.
          </Text>
          <ActionBtn title="Cancel Booking" variant="danger" onPress={doCancelBooking} loading={saving} />
        </BottomSheet>
      </ScrollView>
    );
  }

  // ─── TAB: ONBOARDING ───────────────────────────────────────────────────────

  function renderOnboarding() {
    const allotOpts = bookedAllotments.map((a: any) => ({ label: `${a.tenants?.full_name} — ${a.apartments?.apartment_code}-${a.beds?.bed_code}`, value: a.id }));
    const vacantBedOpts = vacantBeds.map((b: any) => ({ label: `${b._aptCode}-${b.bed_code} (${b.bed_type})`, value: b.id }));
    const costs = oForm.allotmentId && oForm.date ? calcOnboardingCosts(oForm.allotmentId, oForm.date, oForm.bedId) : null;

    const recentStaying = [...stayingAllotments].filter((a: any) => a.onboarding_date).sort((a: any, b: any) => (b.onboarding_date || '').localeCompare(a.onboarding_date || '')).slice(0, 10);
    const filtered = filterBySearch(bookedAllotments, ['tenants.full_name', 'apartments.apartment_code'], ts('onboard'));

    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        <SectionTitle title={`Booked — Ready for Onboarding (${bookedAllotments.length})`} />
        <SearchBar tab="onboard" placeholder="Search tenant…" />
        {filtered.length === 0 ? <EmptyCard message="No pending onboardings" /> :
          filtered.map((a: any) => (
            <Card key={a.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm, color: '#0F172A' }}>{a.tenants?.full_name}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>{a.apartments?.apartment_code}-{a.beds?.bed_code} · Planned: {fmtDate(a.onboarding_date)}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#6A2C90' }}>Paid: ₹{fmtAmt(a.paid_amount || a.deposit_paid)}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  {/* Cancel booking — reuses existing cancelOpen/doCancelBooking flow */}
                  <TouchableOpacity
                    onPress={() => { setCancelId(a.id); setCancelOpen(true); }}
                    style={{ backgroundColor: '#FEE2E2', borderRadius: 8, padding: 8 }}
                  >
                    <Ionicons name="close-circle-outline" size={18} color="#DC2626" />
                  </TouchableOpacity>
                  <ActionBtn title="Onboard" small onPress={() => {
                    const d = a.onboarding_date || today();
                    setOForm({ allotmentId: a.id, date: d, bedId: a.bed_id, payMode: '', refNo: '', paidAmount: depositDefault(a.id, d, a.bed_id), bankAccountId: '', ccCharges: '' });
                    setOnboardOpen(true);
                  }} />
                </View>
              </View>
            </Card>
          ))
        }

        {pendingPayments.length > 0 && <>
          <SectionTitle title={`Payment Pending (${pendingPayments.length})`} />
          {pendingPayments.map((a: any) => (
            <Card key={a.id} style={{ borderColor: '#EA580C', borderWidth: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm, color: '#0F172A' }}>{a.tenants?.full_name}</Text>
                  <Row label="Balance Due" value={`₹${fmtAmt(a.balance_due)}`} valueColor="#DC2626" />
                </View>
                <ActionBtn title="Pay" small variant="outline" onPress={() => {
                  setAddPayForm({ allotmentId: a.id, amount: String(Math.ceil(a.balance_due || 0)), paymentMode: '', refNo: '' });
                  setAddPayOpen(true);
                }} />
              </View>
            </Card>
          ))}
        </>}

        {recentStaying.length > 0 && <>
          <SectionTitle title="Recently Onboarded" />
          {recentStaying.map((a: any) => (
            <Card key={a.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm }}>{a.tenants?.full_name}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>{a.apartments?.apartment_code}-{a.beds?.bed_code} · {fmtDate(a.onboarding_date)}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#6A2C90' }}>Rent: ₹{fmtAmt(a.monthly_rental)}/mo · Deposit: ₹{fmtAmt(a.deposit_paid)}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <TouchableOpacity onPress={() => { setEditOccForm({ allotmentId: a.id, onboardingDate: a.onboarding_date || '', discount: String(a.discount || 0), premium: String(a.premium || 0), depositPaid: String(a.deposit_paid || 0) }); setEditOccOpen(true); }}
                    style={{ backgroundColor: '#F3ECF9', borderRadius: 8, padding: 8 }}>
                    <Ionicons name="pencil-outline" size={16} color="#6A2C90" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => doUndoOnboarding(a.id)}
                    style={{ backgroundColor: '#FEE2E2', borderRadius: 8, padding: 8 }}>
                    <Ionicons name="return-up-back-outline" size={16} color="#DC2626" />
                  </TouchableOpacity>
                </View>
              </View>
            </Card>
          ))}
        </>}

        {/* Onboarding form */}
        <BottomSheet visible={onboardOpen} onClose={() => { setOnboardOpen(false); setKycFront(null); setKycBack(null); setOnboardProof(null); }} title="Onboard Tenant">
          <Field label="Tenant *">
            <SelectF options={allotOpts} value={oForm.allotmentId} onChange={v => {
              const a = bookedAllotments.find((x: any) => x.id === v);
              const d = a?.onboarding_date || today();
              setOForm({ ...oForm, allotmentId: v, bedId: a?.bed_id || '', date: d, paidAmount: depositDefault(v, d, a?.bed_id || '') });
            }} />
          </Field>
          <Field label="Onboarding Date *"><DateF value={oForm.date} onChange={v => setOForm({ ...oForm, date: v, paidAmount: depositDefault(oForm.allotmentId, v, oForm.bedId) })} /></Field>
          <Field label="Bed (optional override)">
            <SelectF options={[{ label: '— Keep current bed —', value: '' }, ...vacantBedOpts]} value={oForm.bedId} onChange={v => setOForm({ ...oForm, bedId: v, paidAmount: depositDefault(oForm.allotmentId, oForm.date, v) })} />
          </Field>
          {costs && (
            <Card style={{ marginBottom: 14 }}>
              <Row label="Bed Rate" value={`₹${fmtAmt(costs.monthlyRent)}/mo`} />
              {costs.discount > 0 && <Row label="Discount" value={`-₹${fmtAmt(costs.discount)}`} valueColor="#16A34A" />}
              <Row label="Effective Rent" value={`₹${fmtAmt(costs.effectiveRent)}/mo`} />
              <Divider />
              <Row label="Onboarding Fee" value={`₹${fmtAmt(costs.onboardingCharges)}`} />
              <Row label="Advance (×1.5)" value={`₹${fmtAmt(costs.advance)}`} />
              <Row label={`Pro-rated (${costs.remainingDays}d)`} value={`₹${fmtAmt(costs.proratedRent)}`} />
              <Divider />
              <Row label="Total Due" value={`₹${fmtAmt(costs.totalDue)}`} />
              <Row label="Already Paid" value={`-₹${fmtAmt(costs.alreadyPaid)}`} valueColor="#16A34A" />
              <Row label="Balance Due" value={`₹${fmtAmt(costs.balance)}`} valueColor="#DC2626" />
            </Card>
          )}
          {/* ── Offline KYC Document (above payment, mirrors web app) ────────── */}
          <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <Ionicons name="card-outline" size={14} color="#6A2C90" />
              <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#6A2C90', letterSpacing: 1, textTransform: 'uppercase' }}>
                Offline KYC Document
              </Text>
              <View style={{ backgroundColor: '#FEE2E2', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 9, color: '#DC2626', fontWeight: '700' }}>Required</Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              {(['front', 'back'] as const).map(side => {
                const photo = side === 'front' ? kycFront : kycBack;
                const label = side === 'front' ? 'KYC Front' : 'KYC Back';
                const icon  = side === 'front' ? 'id-card-outline' : 'id-card-outline';
                return (
                  <View key={side} style={{ flex: 1 }}>
                    <TouchableOpacity
                      onPress={() => pickKycPhoto(side)}
                      style={{
                        height: 110, borderRadius: 14, borderWidth: 1.5,
                        borderStyle: photo ? 'solid' : 'dashed',
                        borderColor: photo ? '#6A2C90' : '#EEF1F6',
                        backgroundColor: photo ? '#F3ECF9' : 'rgba(106,44,144,0.04)',
                        alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden',
                      }}>
                      {photo ? (
                        <>
                          <Image
                            source={{ uri: photo.uri }}
                            style={{ width: '100%', height: '100%' }}
                            resizeMode="cover"
                          />
                          {/* overlay edit hint */}
                          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0,
                            backgroundColor: 'rgba(106,44,144,0.7)', paddingVertical: 4, alignItems: 'center' }}>
                            <Text style={{ fontSize: 10, color: '#fff', fontWeight: '700' }}>Tap to change</Text>
                          </View>
                        </>
                      ) : (
                        <>
                          <View style={{ width: 40, height: 40, borderRadius: 99, backgroundColor: '#F3ECF9',
                            alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
                            <Ionicons name="camera-outline" size={20} color="#6A2C90" />
                          </View>
                          <Text style={{ fontSize: 12, color: '#556274', fontWeight: '700' }}>{label}</Text>
                          <Text style={{ fontSize: 10, color: '#64748B', marginTop: 2 }}>Tap to upload</Text>
                        </>
                      )}
                    </TouchableOpacity>

                    {/* status indicator below card */}
                    {photo && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5, justifyContent: 'center' }}>
                        {kycUploading ? (
                          <>
                            <ActivityIndicator size={10} color="#6A2C90" />
                            <Text style={{ fontSize: 10, color: '#6A2C90' }}>Uploading…</Text>
                          </>
                        ) : (
                          <>
                            <Ionicons name="checkmark-circle" size={12} color="#16A34A" />
                            <Text style={{ fontSize: 10, color: '#16A34A', fontWeight: '600' }}>Ready</Text>
                          </>
                        )}
                      </View>
                    )}

                    {/* remove button */}
                    {photo && (
                      <TouchableOpacity
                        onPress={() => side === 'front' ? setKycFront(null) : setKycBack(null)}
                        style={{ position: 'absolute', top: 6, right: 6, backgroundColor: 'rgba(220,38,38,0.85)',
                          borderRadius: 99, width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="close" size={13} color="#fff" />
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>

            <Text style={{ fontSize: 10, color: '#64748B', marginTop: 8, textAlign: 'center' }}>
              Upload Aadhaar / PAN / Passport front & back photos
            </Text>
          </View>

          {/* ── Payment ─────────────────────────────────────────────────────── */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Ionicons name="cash-outline" size={14} color="#6A2C90" />
            <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#6A2C90', letterSpacing: 1, textTransform: 'uppercase' }}>
              Payment
            </Text>
          </View>

          {/* ── Payment Proof (gallery or camera) — upload first; scan auto-fills amount / ref / bank ─── */}
          <View style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="receipt-outline" size={14} color="#6A2C90" />
                <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#6A2C90', letterSpacing: 1, textTransform: 'uppercase' }}>
                  Payment Proof
                </Text>
                <View style={{ backgroundColor: '#F3ECF9', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 9, color: '#64748B', fontWeight: '600' }}>Optional</Text>
                </View>
              </View>
              {proofScanning.onboarding && (
                <Text style={{ fontSize: 10, color: '#6A2C90', fontWeight: '700' }}>Scanning receipt…</Text>
              )}
              {onboardProof && !proofScanning.onboarding && (
                <TouchableOpacity onPress={() => setOnboardProof(null)}>
                  <Text style={{ fontSize: fontSize.xs, color: '#DC2626', fontWeight: '700' }}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity
              onPress={() => pickProof('onboarding')}
              style={{
                height: onboardProof ? 160 : 80,
                borderRadius: 14, borderWidth: 1.5,
                borderStyle: onboardProof ? 'solid' : 'dashed',
                borderColor: onboardProof ? '#6A2C90' : '#EEF1F6',
                backgroundColor: onboardProof ? '#F3ECF9' : 'rgba(106,44,144,0.04)',
                alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {onboardProof ? (
                <>
                  <Image source={{ uri: onboardProof.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(106,44,144,0.75)', paddingVertical: 5, alignItems: 'center' }}>
                    <Text style={{ fontSize: 11, color: '#fff', fontWeight: '700' }}>Tap to change</Text>
                  </View>
                </>
              ) : (
                <View style={{ alignItems: 'center', gap: 6 }}>
                  <View style={{ flexDirection: 'row', gap: 16 }}>
                    <View style={{ alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 99, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="image-outline" size={18} color="#6A2C90" />
                      </View>
                      <Text style={{ fontSize: 10, color: '#556274', fontWeight: '600' }}>Gallery</Text>
                    </View>
                    <View style={{ alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 99, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="camera-outline" size={18} color="#6A2C90" />
                      </View>
                      <Text style={{ fontSize: 10, color: '#556274', fontWeight: '600' }}>Camera</Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 10, color: '#64748B' }}>Upload receipt / screenshot</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Amount Paying Now"><TextF value={oForm.paidAmount} onChange={v => {
              const ccRate = getCcChargeRate();
              const cc = oForm.payMode === 'credit_card' ? String(Math.ceil((parseFloat(v) || 0) * ccRate)) : '';
              setOForm({ ...oForm, paidAmount: v, ccCharges: cc });
            }} keyboardType="numeric" placeholder={costs ? String(costs.balance) : '0'} /></Field></View>
            <View style={{ flex: 1 }}><Field label="Payment Mode *"><SelectF options={PAY_MODES} value={oForm.payMode} onChange={v => {
              const ccRate = getCcChargeRate();
              const cc = v === 'credit_card' ? String(Math.ceil((parseFloat(oForm.paidAmount) || 0) * ccRate)) : '';
              setOForm({ ...oForm, payMode: v, ccCharges: cc });
            }} /></Field></View>
          </View>

          <Field label="Reference Number *"><TextF value={oForm.refNo} onChange={v => setOForm({ ...oForm, refNo: v })} /></Field>

          {/* ── Bank Details (mirrors web app) ─────────────────────────────── */}
          <Field label="Bank Details">
            {bankAccountOptions.length === 0
              ? <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginTop: 4 }}>No bank accounts found. Add one under Accounting → Bank Accounts.</Text>
              : <SelectF options={[{ label: '— Select bank account —', value: '' }, ...bankAccountOptions]} value={oForm.bankAccountId} onChange={v => setOForm({ ...oForm, bankAccountId: v })} placeholder="Select organisation bank account" />
            }
          </Field>

          {/* ── CC Charges (shown only when credit_card selected) ────────────── */}
          {oForm.payMode === 'credit_card' && (
            <View style={{ marginBottom: 14 }}>
              <Card style={{ marginBottom: 0 }}>
                <Row label="CC Charges" value={`₹${fmtAmt(parseFloat(oForm.ccCharges) || 0)}`} valueColor="#EA580C" />
                <Divider />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#0F172A' }}>Total Amount (incl. CC)</Text>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: '900', color: '#6A2C90' }}>
                    ₹{fmtAmt((parseFloat(oForm.paidAmount) || 0) + (parseFloat(oForm.ccCharges) || 0))}
                  </Text>
                </View>
              </Card>
            </View>
          )}

          <ActionBtn title="Complete Onboarding" onPress={doOnboard} loading={saving || kycUploading || proofUploading} disabled={!oForm.allotmentId || !oForm.date || !oForm.payMode || !oForm.refNo || !kycFront || !kycBack} />
          {(!kycFront || !kycBack) && oForm.allotmentId && (
            <Text style={{ fontSize: fontSize.xs, color: '#DC2626', textAlign: 'center', marginTop: 6 }}>
              KYC front & back photos are required to complete onboarding
            </Text>
          )}

          {/* Registration PDF — generate → preview (Terms of Stay) → download / WhatsApp */}
          <TouchableOpacity
            onPress={handleGenerateRegistration}
            disabled={!oForm.allotmentId || !oForm.date || !oForm.payMode || !oForm.refNo || regGenerating}
            style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
              marginTop: 10, paddingVertical: 13, borderRadius: borderRadius.lg,
              borderWidth: 1.5, borderColor: '#6A2C90',
              backgroundColor: (!oForm.allotmentId || !oForm.date || !oForm.payMode || !oForm.refNo) ? 'rgba(106,44,144,0.05)' : 'rgba(106,44,144,0.08)',
              opacity: (!oForm.allotmentId || !oForm.date || !oForm.payMode || !oForm.refNo) ? 0.5 : 1,
            }}
          >
            {regGenerating
              ? <ActivityIndicator size="small" color="#6A2C90" />
              : <Ionicons name="document-text-outline" size={18} color="#6A2C90" />}
            <Text style={{ fontSize: fontSize.md, fontWeight: '800', color: '#6A2C90' }}>
              Generate Registration PDF
            </Text>
          </TouchableOpacity>
        </BottomSheet>

        {/* ── Registration PDF Preview (Terms of Stay) ───────────────────── */}
        <Modal visible={regPreviewOpen} animationType="slide" transparent onRequestClose={() => setRegPreviewOpen(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
            <View style={{ backgroundColor: '#F8FAFC', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%' }}>
              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 18, borderBottomWidth: 1, borderBottomColor: '#EEF1F6' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="document-text" size={18} color="#6A2C90" />
                  </View>
                  <View>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: '#0F172A' }}>Registration Form</Text>
                    <Text style={{ fontSize: 11, color: '#64748B' }}>
                      {regData ? [regData.firstName, regData.lastName].filter(Boolean).join(' ') : ''}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity onPress={() => setRegPreviewOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="close" size={18} color="#556274" />
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 30 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <Ionicons name="checkmark-circle-outline" size={18} color="#16a34a" />
                  <Text style={{ fontSize: 13, color: '#556274', flex: 1 }}>
                    Tick every Term of Stay below before sending or downloading the form.
                  </Text>
                </View>

                {/* Terms of Stay checklist */}
                {TERMS_OF_STAY.map((t, i) => {
                  const on = !!regTicks[t.id];
                  return (
                    <TouchableOpacity
                      key={t.id}
                      activeOpacity={0.8}
                      onPress={() => setRegTicks((p) => ({ ...p, [t.id]: !p[t.id] }))}
                      style={{ flexDirection: 'row', gap: 10, backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: on ? 'rgba(22,163,74,0.4)' : 'rgba(106,44,144,0.1)' }}
                    >
                      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: on ? '#16a34a' : '#CBD5E1', backgroundColor: on ? '#16a34a' : 'transparent', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                        {on && <Ionicons name="checkmark" size={14} color="#fff" />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 12.5, color: '#0F172A', lineHeight: 18 }}>
                          <Text style={{ fontWeight: '800', color: '#6A2C90' }}>{i + 1}. </Text>{t.text}
                        </Text>
                        {t.subItems?.map((s, j) => (
                          <Text key={j} style={{ fontSize: 11.5, color: '#556274', lineHeight: 16, marginTop: 3, marginLeft: 6 }}>{s}</Text>
                        ))}
                        {t.footnote && <Text style={{ fontSize: 11.5, fontStyle: 'italic', color: '#DC2626', marginTop: 3 }}>{t.footnote}</Text>}
                      </View>
                    </TouchableOpacity>
                  );
                })}

                <Text style={{ fontSize: 12, fontWeight: '700', color: allTicked ? '#16a34a' : '#EA580C', textAlign: 'center', marginTop: 8 }}>
                  {allTicked ? `All ${TERMS_OF_STAY.length} terms acknowledged.` : `Acknowledged ${Object.values(regTicks).filter(Boolean).length} of ${TERMS_OF_STAY.length}. Tick all to continue.`}
                </Text>
              </ScrollView>

              {/* Actions */}
              <View style={{ padding: 18, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#EEF1F6', gap: 10 }}>
                <TouchableOpacity
                  onPress={handleShareRegistration}
                  disabled={!allTicked}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: borderRadius.lg, backgroundColor: allTicked ? '#6A2C90' : '#94A3B8' }}
                >
                  <Ionicons name="download-outline" size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '800' }}>Download / Share PDF</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleSendWhatsapp}
                  disabled={!allTicked || regSendingWa}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: borderRadius.lg, borderWidth: 1.5, borderColor: '#25D366', backgroundColor: allTicked ? 'rgba(37,211,102,0.08)' : 'rgba(0,0,0,0.03)', opacity: allTicked ? 1 : 0.5 }}
                >
                  {regSendingWa
                    ? <ActivityIndicator size="small" color="#25D366" />
                    : <Ionicons name="logo-whatsapp" size={18} color="#25D366" />}
                  <Text style={{ color: '#0F172A', fontSize: fontSize.md, fontWeight: '800' }}>Send Registration via WhatsApp</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Add payment */}
        <BottomSheet visible={addPayOpen} onClose={() => setAddPayOpen(false)} title="Add Payment">
          <Field label="Amount (₹) *"><TextF value={addPayForm.amount} onChange={v => {
            const ccRate = getCcChargeRate();
            const cc = addPayForm.paymentMode === 'credit_card' ? String(Math.ceil((parseFloat(v) || 0) * ccRate)) : '';
            setAddPayForm({ ...addPayForm, amount: v, ccCharges: cc });
          }} keyboardType="numeric" /></Field>
          <Field label="Payment Mode *"><SelectF options={PAY_MODES} value={addPayForm.paymentMode} onChange={v => {
            const ccRate = getCcChargeRate();
            const cc = v === 'credit_card' ? String(Math.ceil((parseFloat(addPayForm.amount) || 0) * ccRate)) : '';
            setAddPayForm({ ...addPayForm, paymentMode: v, ccCharges: cc });
          }} /></Field>
          <Field label="Reference"><TextF value={addPayForm.refNo} onChange={v => setAddPayForm({ ...addPayForm, refNo: v })} /></Field>

          {/* ── Bank Details ─────────────────────────────────────────────────── */}
          <Field label="Bank Details">
            {bankAccountOptions.length === 0
              ? <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginTop: 4 }}>No bank accounts found.</Text>
              : <SelectF options={[{ label: '— Select bank account —', value: '' }, ...bankAccountOptions]} value={addPayForm.bankAccountId} onChange={v => setAddPayForm({ ...addPayForm, bankAccountId: v })} placeholder="Select organisation bank account" />
            }
          </Field>

          {/* ── CC Charges ───────────────────────────────────────────────────── */}
          {addPayForm.paymentMode === 'credit_card' && (
            <Card style={{ marginBottom: 14 }}>
              <Row label="CC Charges" value={`₹${fmtAmt(parseFloat(addPayForm.ccCharges) || 0)}`} valueColor="#EA580C" />
              <Divider />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#0F172A' }}>Total Amount (incl. CC)</Text>
                <Text style={{ fontSize: fontSize.sm, fontWeight: '900', color: '#6A2C90' }}>
                  ₹{fmtAmt((parseFloat(addPayForm.amount) || 0) + (parseFloat(addPayForm.ccCharges) || 0))}
                </Text>
              </View>
            </Card>
          )}

          <ActionBtn title="Record Payment" onPress={doAddPayment} loading={saving} />
        </BottomSheet>

        {/* Edit occupied */}
        <BottomSheet visible={editOccOpen} onClose={() => setEditOccOpen(false)} title="Edit Allotment">
          <Field label="Onboarding Date"><DateF value={editOccForm.onboardingDate} onChange={v => setEditOccForm({ ...editOccForm, onboardingDate: v })} /></Field>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Discount (₹)"><TextF value={editOccForm.discount} onChange={v => setEditOccForm({ ...editOccForm, discount: v })} keyboardType="numeric" /></Field></View>
            <View style={{ flex: 1 }}><Field label="Premium (₹)"><TextF value={editOccForm.premium} onChange={v => setEditOccForm({ ...editOccForm, premium: v })} keyboardType="numeric" /></Field></View>
          </View>
          <Field label="Security Deposit (₹)"><TextF value={editOccForm.depositPaid} onChange={v => setEditOccForm({ ...editOccForm, depositPaid: v })} keyboardType="numeric" /></Field>
          <ActionBtn title="Save Changes" onPress={doEditOccupied} loading={saving} />
        </BottomSheet>
      </ScrollView>
    );
  }

  // ─── TAB: SWITCH ───────────────────────────────────────────────────────────

  function renderSwitch() {
    const stayingOpts = stayingAllotments.map((a: any) => ({ label: `${a.tenants?.full_name} — ${a.apartments?.apartment_code}-${a.beds?.bed_code}`, value: a.id }));
    const switchBedOpts = vacantBeds.filter((b: any) => b.id !== swForm.oldBedId).map((b: any) => ({ label: `${b._aptCode}-${b.bed_code} (${b.bed_type}) — ₹${fmtAmt(getBedRate(b.id))}/mo`, value: b.id }));
    const filtered = filterBySearch(roomSwitches, ['tenantName'], ts('switch'));

    // Resolve a bed id → "APT-BED (Property)".
    const bedLoc = (bedId: string) => {
      const b = bedById[bedId];
      if (!b) return '—';
      const apt = aptById[b.apartment_id] || {};
      const prop = propById[apt.property_id] || {};
      const code = `${apt.apartment_code || '?'}-${b.bed_code || '?'}`;
      return prop.property_name ? `${code} (${prop.property_name})` : code;
    };

    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <SectionTitle title={`Room Switching`} />
          <ActionBtn title="New Switch" icon="swap-horizontal-outline" small onPress={() => setSwitchOpen(true)} />
        </View>
        <SearchBar tab="switch" placeholder="Search by tenant name..." />
        {filtered.length === 0 ? <EmptyCard message="No room switches" /> :
          filtered.map((s: any) => (
            <Card key={s._id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontWeight: '700', fontSize: fontSize.sm, flex: 1 }}>{s.tenantName}</Text>
                <View style={{ backgroundColor: '#DCFCE7', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>Completed</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <Text style={{ fontSize: fontSize.xs, color: '#556274' }}>{bedLoc(s.oldBedId)}</Text>
                <Ionicons name="arrow-forward" size={12} color="#64748B" />
                <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#0F172A' }}>{bedLoc(s.newBedId)}</Text>
              </View>
              <View style={{ marginTop: 8 }}>
                <Row label="Type" value={s.switchType === 'immediate' ? 'Immediate' : (s.switchType || '—')} />
                <Row label="Switch Date" value={fmtDate(s.switchDate)} />
                <Row label="Rent Diff" value={`${s.rentDifference > 0 ? '+' : ''}₹${fmtAmt(s.rentDifference)}`} valueColor={s.rentDifference > 0 ? '#DC2626' : '#16A34A'} />
                <Row label="EB" value="—" />
                <Row label="Deposit Diff" value="—" />
              </View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <ActionBtn title="View" icon="eye-outline" small onPress={() => openStatement(s)} />
                <ActionBtn title="Reswitch" icon="swap-horizontal-outline" small onPress={() => doReswitch(s)} />
              </View>
            </Card>
          ))
        }

        <BottomSheet visible={switchOpen} onClose={() => setSwitchOpen(false)} title="Room Switch">
          <Field label="Tenant (Staying) *">
            <SelectF options={stayingOpts} value={swForm.allotmentId} onChange={v => {
              const a = stayingAllotments.find((x: any) => x.id === v);
              const rate = getBedRate(a?.bed_id || '');
              setSwForm({ ...swForm, allotmentId: v, tenantId: a?.tenant_id || '', oldBedId: a?.bed_id || '', newBedId: '', oldRate: rate });
            }} />
          </Field>
          <Field label="New Bed *">
            <SelectF options={switchBedOpts} value={swForm.newBedId} onChange={v => {
              const b = bedById[v];
              const apt = aptById[b?.apartment_id];
              const rate = getBedRate(v);
              setSwForm({ ...swForm, newBedId: v, newRate: rate, newAptId: apt?.id || '', newPropId: apt?.property_id || '' });
            }} />
          </Field>
          {swForm.oldBedId && swForm.newBedId && (
            <Card style={{ marginBottom: 14 }}>
              <Row label="Current Rent" value={`₹${fmtAmt(swForm.oldRate)}`} />
              <Row label="New Rent" value={`₹${fmtAmt(swForm.newRate)}`} />
              <Row label="Difference" value={`${swForm.newRate - swForm.oldRate > 0 ? '+' : ''}₹${fmtAmt(swForm.newRate - swForm.oldRate)}`} valueColor={swForm.newRate > swForm.oldRate ? '#DC2626' : '#16A34A'} />
            </Card>
          )}
          <Field label="Switch Date"><DateF value={swForm.switchDate} onChange={v => setSwForm({ ...swForm, switchDate: v })} /></Field>
          <ActionBtn title="Process Switch" onPress={doSwitch} loading={saving} disabled={!swForm.allotmentId || !swForm.newBedId} />
        </BottomSheet>

        {/* ── Tenant Statement (opened from a switch row's "View") ── */}
        <BottomSheet visible={!!stmtCtx} onClose={() => setStmtCtx(null)} title={`Tenant Statement — ${stmtCtx?.tenantName || ''}`}>
          {stmtCtx ? (() => {
            const typeLabel = (t: string) => t === 'booking' ? 'Booking' : t === 'onboarding' ? 'Onboarding' : t === 'additional_payment' ? 'Payment' : t === 'settlement' ? 'Settlement' : t === 'rent' ? 'Rent' : (t || 'Payment');
            const pays = stmtReceipts;
            const settles = pays.filter((r: any) => r.receiptType === 'settlement');

            // Charges & Payments ledger: invoices = debits, receipts = credits, running balance.
            const invEntries = stmtInvoices.map((i: any) => ({
              date: i.billingMonth || '', sortKey: (i.billingMonth || '9999-99') + '-15',
              category: 'Invoice', desc: i.invoiceNumber || 'Invoice',
              debit: Number(i.totalAmount) || 0, credit: 0,
            }));
            const payEntries = pays.map((r: any) => ({
              date: r.paymentDate || '', sortKey: r.paymentDate || '9999-99-99',
              category: 'Payment', desc: `${typeLabel(r.receiptType)}${r.paymentMode ? ' · ' + r.paymentMode : ''}`,
              debit: 0, credit: Number(r.amountPaid) || 0,
            }));
            const ledger = [...invEntries, ...payEntries].sort((a: any, b: any) => String(a.sortKey).localeCompare(String(b.sortKey)));
            let running = 0;
            ledger.forEach((e: any) => { running += e.debit - e.credit; e.balance = running; });

            const totalCharged = invEntries.reduce((n: number, e: any) => n + e.debit, 0);
            const totalPaid = payEntries.reduce((n: number, e: any) => n + e.credit, 0);
            const totalSettled = settles.reduce((n: number, r: any) => n + r.amountPaid, 0);
            const balanceDue = totalCharged - totalPaid;
            const allot = allotments.find((a: any) => a.id === stmtCtx.allotmentId) || allotments.find((a: any) => a.tenant_id === stmtCtx.tenantId);
            const deposit = Number(allot?.deposit_paid) || 0;

            const TABS3: { k: 'ledger' | 'deposit' | 'summary'; label: string }[] = [
              { k: 'ledger',  label: 'Charges & Payments' },
              { k: 'deposit', label: 'Deposit Ledger' },
              { k: 'summary', label: 'Summary' },
            ];

            return (
              <View>
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
                  {TABS3.map(t => (
                    <TouchableOpacity key={t.k} onPress={() => setStmtTab(t.k)}
                      style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10, backgroundColor: stmtTab === t.k ? '#6A2C90' : 'rgba(106,44,144,0.08)' }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: stmtTab === t.k ? '#fff' : '#6A2C90', textAlign: 'center' }}>{t.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {stmtLoading ? <EmptyCard message="Loading…" /> : (
                  <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 520 }}>
                    {stmtTab === 'ledger' && (
                      ledger.length === 0 ? <EmptyCard message="No charges or payments" /> :
                      ledger.map((e: any, idx: number) => (
                        <Card key={idx}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <View style={{ flex: 1, marginRight: 8 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <View style={{ backgroundColor: e.category === 'Invoice' ? 'rgba(220,38,38,0.1)' : 'rgba(22,163,74,0.1)', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 }}>
                                  <Text style={{ fontSize: 9, fontWeight: '800', color: e.category === 'Invoice' ? '#DC2626' : '#16A34A' }}>{e.category}</Text>
                                </View>
                                <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>{e.date || '—'}</Text>
                              </View>
                              <Text style={{ fontSize: fontSize.xs, color: '#556274', marginTop: 3 }} numberOfLines={1}>{e.desc}</Text>
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                              {e.debit ? <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#DC2626' }}>₹{fmtAmt(e.debit)}</Text> : null}
                              {e.credit ? <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#16A34A' }}>−₹{fmtAmt(e.credit)}</Text> : null}
                              <Text style={{ fontSize: 10, color: '#64748B', marginTop: 2 }}>Bal ₹{fmtAmt(e.balance)}</Text>
                            </View>
                          </View>
                        </Card>
                      ))
                    )}

                    {stmtTab === 'deposit' && (
                      <Card>
                        <Row label="Deposit Collected" value={`₹${fmtAmt(deposit)}`} />
                        {depEdit.editing ? (
                          <View style={{ marginVertical: 8 }}>
                            <Field label="Deposit Collected (₹)"><TextF value={depEdit.value} onChange={(v: string) => setDepEdit({ editing: true, value: v })} keyboardType="numeric" /></Field>
                            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                              <ActionBtn title="Save" small onPress={() => doSaveDeposit(allot, depEdit.value)} loading={saving} />
                              <ActionBtn title="Cancel" small onPress={() => setDepEdit({ editing: false, value: '' })} />
                            </View>
                          </View>
                        ) : (
                          <TouchableOpacity onPress={() => setDepEdit({ editing: true, value: String(deposit) })}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 6, marginBottom: 6 }}>
                            <Ionicons name="pencil-outline" size={14} color="#6A2C90" />
                            <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#6A2C90' }}>Edit Deposit</Text>
                          </TouchableOpacity>
                        )}
                        {settles.length === 0 ? <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginVertical: 4 }}>No settlement entries.</Text> :
                          settles.map((r: any) => (
                            <Row key={r._id} label={`Settled · ${fmtDate(r.paymentDate)}`} value={`−₹${fmtAmt(r.amountPaid)}`} valueColor="#DC2626" />
                          ))}
                        <Row label="Net Deposit Held" value={`₹${fmtAmt(deposit - totalSettled)}`} valueColor="#16A34A" />
                        <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginTop: 8 }}>
                          Editing updates the deposit held on the allotment. Full per-entry ledger edit needs the pending backend deploy.
                        </Text>
                      </Card>
                    )}

                    {stmtTab === 'summary' && (
                      <Card>
                        <Row label="Total Charged" value={`₹${fmtAmt(totalCharged)}`} valueColor="#DC2626" />
                        <Row label="Total Paid" value={`₹${fmtAmt(totalPaid)}`} valueColor="#16A34A" />
                        <Row label="Balance Due" value={`₹${fmtAmt(balanceDue)}`} valueColor={balanceDue > 0 ? '#DC2626' : '#16A34A'} />
                        <Row label="Deposit Held" value={`₹${fmtAmt(deposit - totalSettled)}`} />
                        <Row label="Invoices" value={`${stmtInvoices.length}`} />
                        <Row label="Payments" value={`${pays.length}`} />
                      </Card>
                    )}
                  </ScrollView>
                )}
              </View>
            );
          })() : null}
        </BottomSheet>
      </ScrollView>
    );
  }

  // ─── TAB: NOTICES ──────────────────────────────────────────────────────────

  function renderNotices() {
    const stayingOpts = stayingAllotments.map((a: any) => ({ label: `${a.tenants?.full_name} — ${a.apartments?.apartment_code}-${a.beds?.bed_code}`, value: a.id }));
    const filtered = filterBySearch(onNotice, ['tenants.full_name', 'apartments.apartment_code'], ts('notices'));

    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <SectionTitle title="Tenant Notices" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {/* Voice Notice Button */}
            <TouchableOpacity
              onPress={() => { setNoticeRecState('idle'); setNoticeTranscript(''); setNoticeVoiceErr(''); setVoiceNoticeOpen(true); }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFEDD5', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#EA580C' }}
            >
              <Ionicons name="mic-outline" size={16} color="#EA580C" />
              <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#EA580C' }}>Voice</Text>
            </TouchableOpacity>
            <ActionBtn title="Record Notice" icon="notifications-outline" small onPress={() => setNoticeOpen(true)} />
          </View>
        </View>
        <SearchBar tab="notices" placeholder="Search by tenant name..." />
        {filtered.length === 0 ? <EmptyCard message="No tenants on notice" /> :
          filtered.map((a: any) => {
            const noticeRecord = notices.find((n: any) => n.allotment_id === a.id);
            return (
              <Card key={a.id}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '700', fontSize: fontSize.sm }}>{a.tenants?.full_name}</Text>
                    <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>{a.apartments?.apartment_code}-{a.beds?.bed_code}</Text>
                    <Row label="Notice Date" value={fmtDate(a.notice_date)} valueColor="#EA580C" />
                    <Row label="Est. Exit" value={fmtDate(a.estimated_exit_date)} valueColor="#DC2626" />
                  </View>
                  <View style={{ gap: 6 }}>
                    <TouchableOpacity onPress={() => {
                      setEditNoticeForm({ noticeId: noticeRecord?.id || '', allotmentId: a.id, bedId: a.bed_id, tenantId: a.tenant_id, noticeDate: a.notice_date || '', exitDate: a.estimated_exit_date || '', notes: noticeRecord?.notes || '' });
                      setEditNoticeOpen(true);
                    }} style={{ backgroundColor: '#F3ECF9', borderRadius: 8, padding: 8 }}>
                      <Ionicons name="pencil-outline" size={16} color="#6A2C90" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => doDeleteNotice(noticeRecord || { id: '', allotment_id: a.id, bed_id: a.bed_id, tenant_id: a.tenant_id })}
                      style={{ backgroundColor: '#FEE2E2', borderRadius: 8, padding: 8 }}>
                      <Ionicons name="close-outline" size={16} color="#DC2626" />
                    </TouchableOpacity>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => doCreatePreExitTask(a)}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, backgroundColor: 'rgba(234,88,12,0.08)', borderRadius: 10, paddingVertical: 9, borderWidth: 1, borderColor: 'rgba(234,88,12,0.25)' }}
                >
                  <Ionicons name="clipboard-outline" size={15} color="#EA580C" />
                  <Text style={{ fontSize: fontSize.xs, fontWeight: '800', color: '#EA580C' }}>Create Pre-Exit Task</Text>
                </TouchableOpacity>
              </Card>
            );
          })
        }

        {/* ── Voice Notice Modal ── */}
        <Modal visible={voiceNoticeOpen} transparent animationType="slide" onRequestClose={() => setVoiceNoticeOpen(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
            <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, paddingBottom: 40, minHeight: 380 }}>
              {/* Header */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <Text style={{ fontSize: fontSize.lg, fontWeight: '800', color: '#1A1A2E' }}>🎙️ Voice Notice</Text>
                <TouchableOpacity onPress={() => { clearNoticeTimers(); if (noticeRecorder.isRecording) noticeRecorder.stop().catch(() => {}); setVoiceNoticeOpen(false); setNoticeRecState('idle'); }}>
                  <Ionicons name="close-circle" size={28} color="#64748B" />
                </TouchableOpacity>
              </View>

              {/* Idle state */}
              {noticeRecState === 'idle' && (
                <View style={{ alignItems: 'center', gap: 16, paddingTop: 20 }}>
                  <Text style={{ fontSize: fontSize.sm, color: '#666', textAlign: 'center', lineHeight: 22 }}>
                    Tap the mic and describe the notice.{'\n'}e.g. "Rahul from A-101 is leaving in 30 days"
                  </Text>
                  <TouchableOpacity
                    onPress={startNoticeRecording}
                    style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: '#EA580C', justifyContent: 'center', alignItems: 'center', shadowColor: '#EA580C', shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 }}
                  >
                    <Ionicons name="mic" size={36} color="#fff" />
                  </TouchableOpacity>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>Tap to start recording</Text>
                </View>
              )}

              {/* Recording state */}
              {noticeRecState === 'recording' && (
                <View style={{ alignItems: 'center', gap: 16, paddingTop: 12 }}>
                  <Text style={{ fontSize: fontSize.sm, color: '#EA580C', fontWeight: '700' }}>Listening…</Text>
                  <View style={{ width: 120, height: 120, justifyContent: 'center', alignItems: 'center' }}>
                    <Animated.View style={{ position: 'absolute', width: 120, height: 120, borderRadius: 60, backgroundColor: '#FED7AA', opacity: noticePulseOpacity1, transform: [{ scale: noticePulseScale1 }] }} />
                    <Animated.View style={{ position: 'absolute', width: 100, height: 100, borderRadius: 50, backgroundColor: '#EA580C', opacity: noticePulseOpacity2, transform: [{ scale: noticePulseScale2 }] }} />
                    <TouchableOpacity
                      onPress={stopNoticeRecording}
                      style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: '#EA580C', justifyContent: 'center', alignItems: 'center', zIndex: 10 }}
                    >
                      <Ionicons name="stop" size={30} color="#fff" />
                    </TouchableOpacity>
                  </View>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>Tap to stop • Auto-stops after 2s silence</Text>
                </View>
              )}

              {/* Transcribing state */}
              {noticeRecState === 'transcribing' && (
                <View style={{ alignItems: 'center', gap: 16, paddingTop: 28 }}>
                  <ActivityIndicator size="large" color="#EA580C" />
                  <Text style={{ fontSize: fontSize.sm, color: '#666' }}>Transcribing your voice…</Text>
                </View>
              )}

              {/* Done state */}
              {noticeRecState === 'done' && (
                <View style={{ gap: 14 }}>
                  <View style={{ backgroundColor: '#FFF8F5', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#FED7AA' }}>
                    <Text style={{ fontSize: fontSize.xs, color: '#EA580C', fontWeight: '700', marginBottom: 6 }}>📝 Transcribed</Text>
                    <TextInput
                      value={noticeTranscript}
                      onChangeText={setNoticeTranscript}
                      multiline
                      style={{ fontSize: fontSize.sm, color: '#1A1A2E', lineHeight: 22, minHeight: 60 }}
                    />
                  </View>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B', textAlign: 'center' }}>
                    Edit if needed, then tap Continue to fill in the notice form.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity
                      onPress={() => { setNoticeRecState('idle'); setNoticeTranscript(''); }}
                      style={{ flex: 1, backgroundColor: '#F5F5F5', borderRadius: 12, paddingVertical: 14, alignItems: 'center' }}
                    >
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#666' }}>Re-record</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={submitVoiceNotice}
                      style={{ flex: 2, backgroundColor: '#EA580C', borderRadius: 12, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
                    >
                      <Ionicons name="arrow-forward-circle-outline" size={20} color="#fff" />
                      <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#fff' }}>Continue to Form</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Error state */}
              {noticeRecState === 'error' && (
                <View style={{ alignItems: 'center', gap: 16, paddingTop: 16 }}>
                  <Ionicons name="warning-outline" size={44} color="#DC2626" />
                  <Text style={{ fontSize: fontSize.sm, color: '#DC2626', textAlign: 'center' }}>{noticeVoiceErr}</Text>
                  <TouchableOpacity
                    onPress={() => setNoticeRecState('idle')}
                    style={{ backgroundColor: '#FEE2E2', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 }}
                  >
                    <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#DC2626' }}>Try Again</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </Modal>

        {/* Notice form */}
        <BottomSheet visible={noticeOpen} onClose={() => setNoticeOpen(false)} title="Record Notice">
          <Field label="Tenant (Staying) *">
            <SelectF options={stayingOpts} value={nForm.allotmentId} onChange={v => {
              const a = stayingAllotments.find((x: any) => x.id === v);
              const exitDate = new Date(); exitDate.setDate(exitDate.getDate() + (config.notice_period_days || 30));
              setNForm({ ...nForm, allotmentId: v, tenantId: a?.tenant_id || '', bedId: a?.bed_id || '', exitDate: exitDate.toISOString().split('T')[0] });
            }} />
          </Field>
          <Field label="Estimated Exit Date *"><DateF value={nForm.exitDate} onChange={v => setNForm({ ...nForm, exitDate: v })} /></Field>
          <Field label="Notes"><TextF value={nForm.notes} onChange={v => setNForm({ ...nForm, notes: v })} multiline /></Field>
          <ActionBtn title="Submit Notice" onPress={doNotice} loading={saving} disabled={!nForm.allotmentId || !nForm.exitDate} />
        </BottomSheet>

        {/* Edit notice */}
        <BottomSheet visible={editNoticeOpen} onClose={() => setEditNoticeOpen(false)} title="Edit Notice">
          <Field label="Notice Date"><DateF value={editNoticeForm.noticeDate} onChange={v => setEditNoticeForm({ ...editNoticeForm, noticeDate: v })} /></Field>
          <Field label="Estimated Exit Date *"><DateF value={editNoticeForm.exitDate} onChange={v => setEditNoticeForm({ ...editNoticeForm, exitDate: v })} /></Field>
          <Field label="Notes"><TextF value={editNoticeForm.notes} onChange={v => setEditNoticeForm({ ...editNoticeForm, notes: v })} multiline /></Field>
          <ActionBtn title="Update Notice" onPress={doUpdateNotice} loading={saving} />
        </BottomSheet>
      </ScrollView>
    );
  }

  // ─── TAB: EXIT ─────────────────────────────────────────────────────────────

  function renderExit() {
    const exitableAllots = [...stayingAllotments, ...onNotice];
    const exitOpts = exitableAllots.map((a: any) => ({
      label: `${a.tenants?.full_name} — ${a.apartments?.apartment_code}-${a.beds?.bed_code} (${a.staying_status})`,
      value: a.id,
    }));

    // Settlement preview
    const selAllot = eForm.allotmentId ? allotments.find((a: any) => a.id === eForm.allotmentId) : null;
    let preview: any = null;
    if (selAllot && eForm.exitDate) {
      const exitDate = new Date(eForm.exitDate);
      const onDate   = selAllot.onboarding_date ? new Date(selAllot.onboarding_date) : new Date();
      const stayDays = Math.floor((exitDate.getTime() - onDate.getTime()) / 86400000);
      const under1yr = stayDays < 365;
      const damage  = parseFloat(eForm.damageCharges) || 0;
      const eb      = parseFloat(eForm.ebCharges) || 0;
      const keyLoss = eForm.keyReturned ? 0 : (config.key_loss_fee || 500);
      const exitChg = under1yr ? (config.exit_fee_under_1yr || 2250) : 0;
      const pendRent= selAllot.balance_due || 0;
      const total   = damage + eb + keyLoss + exitChg + pendRent;
      const advance = selAllot.deposit_paid || 0;
      const refund  = advance - total;
      preview = { stayDays, under1yr, damage, eb, keyLoss, exitChg, pendRent, total, advance, refund };
    }

    const inspectDone = eForm.inspectFurniture && eForm.inspectBed && eForm.inspectWalls && eForm.inspectBathroom;
    const filtered = filterBySearch(exits, ['tenantName', 'tenants.full_name'], ts('exit'));

    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* On notice — ready for exit */}
        {onNotice.length > 0 && <>
          <SectionTitle title={`Tenants on Notice (${onNotice.length})`} />
          {onNotice.map((a: any) => (
            <Card key={a.id} style={{ borderColor: '#EA580C', borderWidth: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm }}>{a.tenants?.full_name}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>{a.apartments?.apartment_code}-{a.beds?.bed_code}</Text>
                  <Row label="Est. Exit" value={fmtDate(a.estimated_exit_date)} valueColor="#EA580C" />
                  <Row label="Advance" value={`₹${fmtAmt(a.deposit_paid)}`} />
                </View>
                <ActionBtn title="Exit" small variant="danger" icon="log-out-outline" onPress={() => {
                  setEForm({ ...blankExit, allotmentId: a.id, tenantId: a.tenant_id, bedId: a.bed_id, exitDate: a.estimated_exit_date || today(), hasNotice: true });
                  setExitOpen(true);
                }} />
              </View>
            </Card>
          ))}
        </>}

        {/* Pre-exit tasks (created via createExitTask, listed from listExitTasks) */}
        {exitTasks.length > 0 && <>
          <SectionTitle title={`Pre-Exit Tasks (${exitTasks.length})`} />
          {exitTasks.map((t: any) => (
            <Card key={t.id || t._id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm }}>{t.tenants?.full_name || t.task || 'Pre-exit task'}</Text>
                  <Row label="Target Exit" value={fmtDate(t.exit_date)} valueColor="#EA580C" />
                  <Row label="Assignee" value={t.assigned_to || 'Unassigned'} />
                </View>
                <StatusPill status={t.status || 'pending'} />
              </View>
            </Card>
          ))}
        </>}

        <SectionTitle title={`Exit History (${exits.length})`} />
        <SearchBar tab="exit" placeholder="Search tenant…" />
        {filtered.length === 0 ? <EmptyCard message="No exits yet" /> :
          filtered.map((e: any) => (
            <Card key={e._id || e.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm }}>{e.tenantName || e.tenants?.full_name}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>Exit: {fmtDate(e.exitDate || e.exit_date)}</Text>
                  <Row label="Advance Held" value={`₹${fmtAmt(e.advanceHeld || e.advance_held)}`} />
                  <Row label="Deductions" value={`₹${fmtAmt(e.totalDeductions || e.total_deductions)}`} />
                  <Row label="Refund Due" value={`₹${fmtAmt(e.refundDue || e.refund_due)}`} valueColor="#16A34A" />
                  <StatusPill status={e.refundStatus || e.refund_status || 'none'} />
                </View>
                <TouchableOpacity onPress={() => {
                  setEditExitForm({ exitId: e._id || e.id, allotmentId: e.allotmentId || e.allotment_id, exitDate: e.exitDate || e.exit_date || '', hasNotice: e.hasNotice || e.has_notice || false, keyReturned: e.keyReturned !== false && e.key_returned !== false, damageCharges: String(e.damageCharges || e.damage_charges || 0), notes: e.notes || '' });
                  setEditExitOpen(true);
                }} style={{ backgroundColor: '#F3ECF9', borderRadius: 8, padding: 8 }}>
                  <Ionicons name="pencil-outline" size={16} color="#6A2C90" />
                </TouchableOpacity>
              </View>
            </Card>
          ))
        }

        {/* Process Exit sheet */}
        <BottomSheet visible={exitOpen} onClose={() => setExitOpen(false)} title="Process Exit">
          <Field label="Tenant *">
            <SelectF options={exitOpts} value={eForm.allotmentId} onChange={v => {
              const a = exitableAllots.find((x: any) => x.id === v);
              setEForm({ ...blankExit, allotmentId: v, tenantId: a?.tenant_id || '', bedId: a?.bed_id || '', hasNotice: a?.staying_status === 'On-Notice', exitDate: a?.estimated_exit_date || today() });
            }} />
          </Field>
          <Field label="Exit Date *"><DateF value={eForm.exitDate} onChange={v => setEForm({ ...eForm, exitDate: v })} /></Field>

          {/* Inspection */}
          <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#556274', marginBottom: 6, letterSpacing: 0.5 }}>ROOM INSPECTION *</Text>
          <Card style={{ marginBottom: 14 }}>
            <CheckRow label="All furniture OK" checked={eForm.inspectFurniture} onChange={v => setEForm({ ...eForm, inspectFurniture: v })} />
            <CheckRow label="Bed not damaged" checked={eForm.inspectBed} onChange={v => setEForm({ ...eForm, inspectBed: v })} />
            <CheckRow label="Walls not damaged" checked={eForm.inspectWalls} onChange={v => setEForm({ ...eForm, inspectWalls: v })} />
            <CheckRow label="Bathroom OK" checked={eForm.inspectBathroom} onChange={v => setEForm({ ...eForm, inspectBathroom: v })} />
            <Divider />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name={inspectDone ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={inspectDone ? '#16A34A' : '#64748B'} />
              <Text style={{ fontSize: fontSize.sm, fontWeight: '600', color: inspectDone ? '#16A34A' : '#64748B' }}>
                {inspectDone ? 'Inspection Complete' : 'Complete all checks above'}
              </Text>
            </View>
          </Card>

          <CheckRow label="Key Returned" checked={eForm.keyReturned} onChange={v => setEForm({ ...eForm, keyReturned: v })} />
          <Field label="Damage Charges (₹)"><TextF value={eForm.damageCharges} onChange={v => setEForm({ ...eForm, damageCharges: v })} keyboardType="numeric" /></Field>
          <Field label="EB Charges (₹)"><TextF value={eForm.ebCharges} onChange={v => setEForm({ ...eForm, ebCharges: v })} keyboardType="numeric" /></Field>

          {/* Exit-month estimated EB — recomputed from the actual exit date (item 6) */}
          {(exitEbLoading || exitEb) && (
            <Card style={{ marginBottom: 14, borderColor: '#FED7AA', borderWidth: 1, backgroundColor: '#FFFBF5' }}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#C2410C', marginBottom: 8 }}>ESTIMATED EB (EXIT MONTH)</Text>
              {exitEbLoading ? (
                <Text style={{ fontSize: fontSize.sm, color: '#64748B' }}>Recomputing from exit date…</Text>
              ) : exitEb ? (
                <>
                  <Row label={`Recomputed (${exitEb.daysInExitMonth} day${exitEb.daysInExitMonth === 1 ? '' : 's'})`} value={`₹${fmtAmt(exitEb.recomputed)}`} valueColor="#C2410C" />
                  {exitEb.estimatedEbIncluded && (
                    <Row label="Already on invoice" value={`₹${fmtAmt(exitEb.invoicedOriginal)}`} />
                  )}
                  {exitEb.estimatedEbIncluded && exitEb.recomputed !== exitEb.invoicedOriginal && (
                    <Text style={{ fontSize: fontSize.xs, color: '#C2410C', marginTop: 6 }}>
                      ⓘ On completing the exit, the invoice EB will change from ₹{fmtAmt(exitEb.invoicedOriginal)} to ₹{fmtAmt(exitEb.recomputed)}.
                    </Text>
                  )}
                  {!exitEb.canRecompute && (
                    <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginTop: 6 }}>
                      Previous-month meter reading missing — keeping the invoiced value.
                    </Text>
                  )}
                </>
              ) : null}
            </Card>
          )}

          {preview && (
            <Card style={{ marginBottom: 14 }}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#556274', marginBottom: 8 }}>SETTLEMENT PREVIEW</Text>
              <Row label={`Stay (${preview.stayDays}d${preview.under1yr ? ' <1yr' : ''})`} value="" />
              <Row label="Pending Rent" value={`₹${fmtAmt(preview.pendRent)}`} />
              <Row label="Damage Charges" value={`₹${fmtAmt(preview.damage)}`} />
              {preview.eb > 0 && <Row label="EB Charges" value={`₹${fmtAmt(preview.eb)}`} />}
              {!eForm.keyReturned && <Row label="Key Loss Fee" value={`₹${fmtAmt(preview.keyLoss)}`} />}
              {preview.under1yr && <Row label="Exit Charges (<1yr)" value={`₹${fmtAmt(preview.exitChg)}`} />}
              <Divider />
              <Row label="Total Deductions" value={`₹${fmtAmt(preview.total)}`} />
              <Row label="Advance Held" value={`₹${fmtAmt(preview.advance)}`} valueColor="#16A34A" />
              <Divider />
              <Row label={preview.refund > 0 ? 'Refund Due' : 'Amount Owed'} value={`₹${fmtAmt(Math.abs(preview.refund))}`} valueColor={preview.refund > 0 ? '#16A34A' : '#DC2626'} />
            </Card>
          )}

          <Field label="Notes"><TextF value={eForm.notes} onChange={v => setEForm({ ...eForm, notes: v })} multiline /></Field>
          <ActionBtn title="Process Exit" variant="danger" onPress={doExit} loading={saving} disabled={!eForm.allotmentId || !eForm.exitDate || !inspectDone} />
          {!inspectDone && eForm.allotmentId && <Text style={{ fontSize: fontSize.xs, color: '#DC2626', textAlign: 'center', marginTop: 8 }}>Complete room inspection to enable exit</Text>}
        </BottomSheet>

        {/* Edit exit sheet */}
        <BottomSheet visible={editExitOpen} onClose={() => setEditExitOpen(false)} title="Edit Exit Record">
          <Field label="Exit Date"><DateF value={editExitForm.exitDate} onChange={v => setEditExitForm({ ...editExitForm, exitDate: v })} /></Field>
          <CheckRow label="Had Notice Period" checked={editExitForm.hasNotice} onChange={v => setEditExitForm({ ...editExitForm, hasNotice: v })} />
          <CheckRow label="Key Returned" checked={editExitForm.keyReturned} onChange={v => setEditExitForm({ ...editExitForm, keyReturned: v })} />
          <Field label="Damage Charges (₹)"><TextF value={editExitForm.damageCharges} onChange={v => setEditExitForm({ ...editExitForm, damageCharges: v })} keyboardType="numeric" /></Field>
          <Field label="Notes"><TextF value={editExitForm.notes} onChange={v => setEditExitForm({ ...editExitForm, notes: v })} multiline /></Field>
          <ActionBtn title="Update Exit" onPress={doUpdateExit} loading={saving} />
        </BottomSheet>
      </ScrollView>
    );
  }

  // ─── TAB: PAYMENTS ─────────────────────────────────────────────────────────

  function renderPayments() {
    const filtered = filterBySearch(receipts, ['tenantName', 'tenantPhone'], ts('payments'));
    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        <SectionTitle title={`Lifecycle Payments (${receipts.length})`} />
        <SearchBar tab="payments" placeholder="Search tenant…" />
        {filtered.length === 0 ? <EmptyCard message="No payments" /> :
          filtered.map((p: any) => (
            <Card key={p._id || p.id}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: fontSize.sm }}>{p.tenantName}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>{p.paymentDate} · {p.paymentMode?.toUpperCase()}</Text>
                  {p.referenceNumber ? <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>Ref: {p.referenceNumber}</Text> : null}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={{ fontWeight: '800', fontSize: fontSize.md, color: '#6A2C90' }}>₹{fmtAmt(p.amountPaid)}</Text>
                  <View style={{ backgroundColor: '#F3ECF9', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ fontSize: 9, color: '#6A2C90', fontWeight: '700', textTransform: 'uppercase' }}>{p.receiptType}</Text>
                  </View>
                </View>
              </View>
            </Card>
          ))
        }
      </ScrollView>
    );
  }

  // ─── TAB: REFUNDS ──────────────────────────────────────────────────────────

  function renderRefunds() {
    const filtered = filterBySearch(pendingRefunds, ['tenantName', 'tenants.full_name'], ts('refunds'));
    return (
      <ScrollView showsVerticalScrollIndicator={false}>
        {overdueRefunds.length > 0 && (
          <Card style={{ borderColor: '#DC2626', borderWidth: 1.5, backgroundColor: '#FEE2E2', marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="warning" size={18} color="#DC2626" />
              <Text style={{ fontSize: fontSize.sm, fontWeight: '700', color: '#DC2626' }}>
                {overdueRefunds.length} overdue refund(s)!
              </Text>
            </View>
          </Card>
        )}
        <SectionTitle title="Refund Tracking" />
        <SearchBar tab="refunds" placeholder="Search by tenant name..." />
        {filtered.length === 0 ? <EmptyCard message="No pending refunds 🎉" /> :
          filtered.map((e: any) => {
            const daysSince = daysBetween(e.exitDate || e.exit_date || '');
            const isOverdue = daysSince > (config.refund_deadline_days || 5);
            return (
              <Card key={e._id || e.id} style={isOverdue ? { borderColor: '#DC2626', borderWidth: 1.5 } : {}}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <Text style={{ fontWeight: '700', fontSize: fontSize.sm }}>{e.tenantName || e.tenants?.full_name}</Text>
                      {isOverdue && <Ionicons name="warning" size={14} color="#DC2626" />}
                    </View>
                    <Text style={{ fontSize: fontSize.xs, color: '#64748B' }}>Exit: {fmtDate(e.exitDate || e.exit_date)} · {daysSince}d ago</Text>
                    <Row label="Advance Held" value={`₹${fmtAmt(e.advanceHeld || e.advance_held)}`} />
                    <Row label="Deductions" value={`₹${fmtAmt(e.totalDeductions || e.total_deductions)}`} />
                    <Row label="Refund Due" value={`₹${fmtAmt(e.refundDue || e.refund_due)}`} valueColor="#16A34A" />
                  </View>
                  <View style={{ gap: 6 }}>
                    <TouchableOpacity onPress={() => {
                      setEditRefundForm({ exitId: e._id || e.id, allotmentId: e.allotmentId || e.allotment_id, advanceHeld: e.advanceHeld || e.advance_held || 0, pendingRent: String(e.pendingRent || e.pending_rent || 0), ebCharges: String(e.ebCharges || e.eb_charges || 0), exitCharges: String(e.exitCharges || e.exit_charges || 0), damageCharges: String(e.damageCharges || e.damage_charges || 0), keyLossFee: String(e.keyLossFee || e.key_loss_fee || 0) });
                      setEditRefundOpen(true);
                    }} style={{ backgroundColor: '#F3ECF9', borderRadius: 8, padding: 8 }}>
                      <Ionicons name="pencil-outline" size={16} color="#6A2C90" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => {
                      setCompleteRefundForm({ exitId: e._id || e.id, allotmentId: e.allotmentId || e.allotment_id, tenantId: e.tenantId || e.tenant_id, tenantName: e.tenantName || e.tenants?.full_name || '', refundDue: e.refundDue || e.refund_due || 0, refundDate: today(), referenceNumber: '', bankAccountId: '' });
                      setRefundProof(null); setRefundProofAmount(null);
                      setCompleteRefundOpen(true);
                    }} style={{ backgroundColor: '#DCFCE7', borderRadius: 8, padding: 8 }}>
                      <Ionicons name="checkmark-circle-outline" size={16} color="#16A34A" />
                    </TouchableOpacity>
                  </View>
                </View>
              </Card>
            );
          })
        }

        {/* Edit refund sheet */}
        <BottomSheet visible={editRefundOpen} onClose={() => setEditRefundOpen(false)} title="Edit Refund Deductions">
          <Card style={{ marginBottom: 14 }}>
            <Row label="Advance Held" value={`₹${fmtAmt(editRefundForm.advanceHeld)}`} />
          </Card>
          {(['pendingRent', 'ebCharges', 'exitCharges', 'damageCharges', 'keyLossFee'] as const).map(field => {
            const labels: any = { pendingRent: 'Pending Rent (₹)', ebCharges: 'EB Charges (₹)', exitCharges: 'Exit Charges (₹)', damageCharges: 'Damage Charges (₹)', keyLossFee: 'Key Loss Fee (₹)' };
            return (
              <Field key={field} label={labels[field]}>
                <TextF value={editRefundForm[field]} onChange={v => setEditRefundForm({ ...editRefundForm, [field]: v })} keyboardType="numeric" />
              </Field>
            );
          })}
          {(() => {
            const total = (['pendingRent', 'ebCharges', 'exitCharges', 'damageCharges', 'keyLossFee'] as const).reduce((s, f) => s + (parseFloat(editRefundForm[f]) || 0), 0);
            const refund = Math.max(0, editRefundForm.advanceHeld - total);
            return (
              <Card style={{ marginBottom: 14 }}>
                <Row label="Total Deductions" value={`₹${fmtAmt(total)}`} valueColor="#DC2626" />
                <Row label="Refund Due" value={`₹${fmtAmt(refund)}`} valueColor="#16A34A" />
              </Card>
            );
          })()}
          <ActionBtn title="Update Deductions" onPress={doEditRefund} loading={saving} />
        </BottomSheet>

        {/* Complete refund sheet */}
        <BottomSheet visible={completeRefundOpen} onClose={() => { setCompleteRefundOpen(false); setRefundProof(null); setRefundProofAmount(null); }} title="Complete Refund">
          <Card style={{ marginBottom: 14 }}>
            <Row label="Tenant" value={completeRefundForm.tenantName} />
            <Row label="Refund Amount" value={`₹${fmtAmt(completeRefundForm.refundDue)}`} valueColor="#16A34A" />
          </Card>

          {/* ── Payment Proof (required) — scanned amount MUST match the refund amount ─── */}
          {(() => {
            const due = Math.round(Number(completeRefundForm.refundDue) || 0);
            const scanned = refundProofAmount;
            const matched = scanned != null && scanned === due;
            return (
              <View style={{ marginBottom: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="receipt-outline" size={14} color="#6A2C90" />
                    <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: '#6A2C90', letterSpacing: 1, textTransform: 'uppercase' }}>
                      Payment Proof
                    </Text>
                    <View style={{ backgroundColor: '#FEE2E2', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 9, color: '#DC2626', fontWeight: '700' }}>Required</Text>
                    </View>
                  </View>
                  {proofScanning.refund && (
                    <Text style={{ fontSize: 10, color: '#6A2C90', fontWeight: '700' }}>Scanning receipt…</Text>
                  )}
                  {refundProof && !proofScanning.refund && (
                    <TouchableOpacity onPress={() => { setRefundProof(null); setRefundProofAmount(null); }}>
                      <Text style={{ fontSize: fontSize.xs, color: '#DC2626', fontWeight: '700' }}>Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <TouchableOpacity
                  onPress={() => pickProof('refund')}
                  style={{
                    height: refundProof ? 160 : 80,
                    borderRadius: 14, borderWidth: 1.5,
                    borderStyle: refundProof ? 'solid' : 'dashed',
                    borderColor: refundProof ? (matched ? '#16A34A' : '#DC2626') : '#EEF1F6',
                    backgroundColor: refundProof ? (matched ? '#DCFCE7' : '#FEE2E2') : 'rgba(106,44,144,0.04)',
                    alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                >
                  {refundProof ? (
                    <>
                      <Image source={{ uri: refundProof.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                      <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(106,44,144,0.75)', paddingVertical: 5, alignItems: 'center' }}>
                        <Text style={{ fontSize: 11, color: '#fff', fontWeight: '700' }}>Tap to change</Text>
                      </View>
                    </>
                  ) : (
                    <View style={{ alignItems: 'center', gap: 6 }}>
                      <View style={{ flexDirection: 'row', gap: 16 }}>
                        <View style={{ alignItems: 'center', gap: 4 }}>
                          <View style={{ width: 36, height: 36, borderRadius: 99, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="image-outline" size={18} color="#6A2C90" />
                          </View>
                          <Text style={{ fontSize: 10, color: '#556274', fontWeight: '600' }}>Gallery</Text>
                        </View>
                        <View style={{ alignItems: 'center', gap: 4 }}>
                          <View style={{ width: 36, height: 36, borderRadius: 99, backgroundColor: '#F3ECF9', alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="camera-outline" size={18} color="#6A2C90" />
                          </View>
                          <Text style={{ fontSize: 10, color: '#556274', fontWeight: '600' }}>Camera</Text>
                        </View>
                      </View>
                      <Text style={{ fontSize: 10, color: '#64748B' }}>Upload the ₹{due} payment screenshot</Text>
                    </View>
                  )}
                </TouchableOpacity>

                {/* match / mismatch indicator */}
                {refundProof && !proofScanning.refund && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 }}>
                    <Ionicons
                      name={matched ? 'checkmark-circle' : 'close-circle'}
                      size={14}
                      color={matched ? '#16A34A' : '#DC2626'}
                    />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: matched ? '#16A34A' : '#DC2626', flex: 1 }}>
                      {scanned == null
                        ? `Couldn't read the amount — upload a clear screenshot showing ₹${due}.`
                        : matched
                          ? `Amount ₹${scanned} matches — refund allowed.`
                          : `Screenshot shows ₹${scanned}, but refund is ₹${due}. Amounts must match.`}
                    </Text>
                  </View>
                )}
              </View>
            );
          })()}

          <Field label="Refund Date *"><DateF value={completeRefundForm.refundDate} onChange={v => setCompleteRefundForm({ ...completeRefundForm, refundDate: v })} /></Field>

          {/* ── Bank Account (mirrors web app) ───────────────────────────────── */}
          <Field label="Bank Account *">
            {bankAccountOptions.length === 0
              ? <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginTop: 4 }}>No bank accounts found. Add one under Accounting → Bank Accounts.</Text>
              : <SelectF options={[{ label: '— Select bank account —', value: '' }, ...bankAccountOptions]} value={completeRefundForm.bankAccountId} onChange={v => setCompleteRefundForm({ ...completeRefundForm, bankAccountId: v })} placeholder="Select bank account" />
            }
          </Field>

          <Field label="Reference / UTR Number *"><TextF value={completeRefundForm.referenceNumber} onChange={v => setCompleteRefundForm({ ...completeRefundForm, referenceNumber: v })} placeholder="Enter UTR or transaction ID" /></Field>
          <ActionBtn
            title="Mark Refund Complete"
            onPress={doCompleteRefund}
            loading={saving}
            disabled={
              !completeRefundForm.referenceNumber ||
              !refundProof ||
              refundProofAmount == null ||
              refundProofAmount !== Math.round(Number(completeRefundForm.refundDue) || 0)
            }
          />
          {refundProof && !proofScanning.refund && refundProofAmount !== Math.round(Number(completeRefundForm.refundDue) || 0) && (
            <Text style={{ fontSize: fontSize.xs, color: '#DC2626', textAlign: 'center', marginTop: 6 }}>
              Refund is blocked until the uploaded screenshot's amount exactly matches ₹{fmtAmt(completeRefundForm.refundDue)}.
            </Text>
          )}
        </BottomSheet>
      </ScrollView>
    );
  }

  // ─── ABSENCE MUTATIONS ───────────────────────────────────────────────────────

  async function doSaveAbsence() {
    if (!absenceForm.tenantId || !absenceForm.fromDate || !absenceForm.toDate)
      return Alert.alert('Validation', 'Select tenant, from date and to date.');
    if (absenceForm.toDate < absenceForm.fromDate)
      return Alert.alert('Validation', 'To date must be on or after from date.');
    await withSave(async () => {
      if (absenceEditId) {
        await client.action((api as any).tenants.updateAbsenceRecord, {
          id: absenceEditId,
          data: { fromDate: absenceForm.fromDate, toDate: absenceForm.toDate, reason: absenceForm.reason },
        });
        Alert.alert('Updated', 'Absence record updated.');
      } else {
        await client.action((api as any).tenants.createAbsenceRecord, {
          data: {
            tenantId: absenceForm.tenantId,
            allotmentId: absenceForm.allotmentId || null,
            fromDate: absenceForm.fromDate,
            toDate: absenceForm.toDate,
            reason: absenceForm.reason,
          },
        });
        Alert.alert('Saved', 'Absence record added.');
      }
      setAbsenceOpen(false);
      setAbsenceEditId(null);
      setAbsenceForm(blankAbsence);
      fetchAll();
    });
  }

  async function doDeleteAbsence(id: string) {
    Alert.alert('Delete Absence', 'Remove this absence record?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await withSave(async () => {
          await client.action((api as any).tenants.deleteAbsenceRecord, { id });
          fetchAll();
        });
      }},
    ]);
  }

  // ─── TAB: NOT IN PROPERTY (Absence Records) ─────────────────────────────────

  function renderAbsent() {
    const tenantOpts = stayingAllotments.map((a: any) => ({
      label: `${a.tenants?.full_name} — ${a.apartments?.apartment_code}-${a.beds?.bed_code}`,
      value: a.tenant_id,
      allotmentId: a.id,
    }));

    const filtered = filterBySearch(absenceRecords, ['tenants.full_name', 'reason'], ts('absent'));

    return (
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Header row */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SectionTitle title="Not in Property" />
          <ActionBtn title="Add Absence" icon="add-circle-outline" small onPress={() => {
            setAbsenceEditId(null);
            setAbsenceForm(blankAbsence);
            setAbsenceOpen(true);
          }} />
        </View>

        {/* Info banner */}
        <View style={{ backgroundColor: VBRAND.purpleSoft, borderRadius: 12, padding: 12, marginBottom: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Ionicons name="information-circle-outline" size={16} color={VBRAND.purpleDeep} style={{ marginTop: 1 }} />
          <Text style={{ flex: 1, fontSize: fontSize.xs, color: VBRAND.ink600, lineHeight: 18 }}>
            Absences over 30 days excluded from electricity billing.
          </Text>
        </View>

        <SearchBar tab="absent" placeholder="Search by tenant name…" />

        {filtered.length === 0 ? (
          <EmptyCard message="No absence records found" />
        ) : (
          filtered.map((r: any) => {
            // Calculate duration in days
            let duration = 0;
            if (r.from_date && r.to_date) {
              try {
                const d1 = new Date(r.from_date);
                const d2 = new Date(r.to_date);
                duration = Math.floor((d2.getTime() - d1.getTime()) / 86400000) + 1;
              } catch (_) {}
            }
            // Find allotment for apt-bed label
            const allot = allotments.find((a: any) => a.id === r.allotment_id);
            const aptBed = allot
              ? `${allot.apartments?.apartment_code || '?'}-${allot.beds?.bed_code || '?'}`
              : '—';

            return (
              <Card key={r.id}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontWeight: '700', fontSize: fontSize.sm, color: '#0F172A' }}>
                      {r.tenants?.full_name || '—'}
                    </Text>
                    <Text style={{ fontSize: fontSize.xs, color: '#64748B', marginBottom: 4 }}>{aptBed}</Text>
                    <Row label="From"     value={fmtDate(r.from_date)} />
                    <Row label="To"       value={fmtDate(r.to_date)} />
                    <Row label="Duration" value={`${duration} day${duration !== 1 ? 's' : ''}`} valueColor="#6A2C90" />
                    {r.reason ? (
                      <Row label="Reason" value={r.reason} />
                    ) : null}
                  </View>
                  <View style={{ gap: 6, marginLeft: 10 }}>
                    <TouchableOpacity
                      onPress={() => {
                        setAbsenceEditId(r.id);
                        setAbsenceForm({
                          allotmentId: r.allotment_id || '',
                          tenantId: r.tenant_id,
                          fromDate: r.from_date,
                          toDate: r.to_date,
                          reason: r.reason || '',
                        });
                        setAbsenceOpen(true);
                      }}
                      style={{ backgroundColor: '#F3ECF9', borderRadius: 8, padding: 8 }}
                    >
                      <Ionicons name="pencil-outline" size={16} color="#6A2C90" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => doDeleteAbsence(r.id)}
                      style={{ backgroundColor: '#FEE2E2', borderRadius: 8, padding: 8 }}
                    >
                      <Ionicons name="trash-outline" size={16} color="#DC2626" />
                    </TouchableOpacity>
                  </View>
                </View>
              </Card>
            );
          })
        )}

        {/* Add / Edit absence sheet */}
        <BottomSheet
          visible={absenceOpen}
          onClose={() => { setAbsenceOpen(false); setAbsenceEditId(null); setAbsenceForm(blankAbsence); }}
          title={absenceEditId ? 'Edit Absence Record' : 'Add Absence Record'}
        >
          {/* Tenant picker — only for new records */}
          {!absenceEditId && (
            <Field label="Tenant (Staying) *">
              <SelectF
                options={[{ label: '— Select tenant —', value: '' }, ...tenantOpts.map((t: any) => ({ label: t.label, value: t.value }))]}
                value={absenceForm.tenantId}
                onChange={v => {
                  const match = tenantOpts.find((t: any) => t.value === v);
                  setAbsenceForm({ ...absenceForm, tenantId: v, allotmentId: match?.allotmentId || '' });
                }}
                placeholder="Select staying tenant…"
              />
            </Field>
          )}

          {/* When editing, show read-only tenant name */}
          {absenceEditId && (() => {
            const rec = absenceRecords.find((r: any) => r.id === absenceEditId);
            return rec ? (
              <Card style={{ marginBottom: 14 }}>
                <Row label="Tenant" value={rec.tenants?.full_name || '—'} />
              </Card>
            ) : null;
          })()}

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Field label="From Date *">
                <DateF value={absenceForm.fromDate} onChange={v => setAbsenceForm({ ...absenceForm, fromDate: v })} />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="To Date *">
                <DateF value={absenceForm.toDate} onChange={v => setAbsenceForm({ ...absenceForm, toDate: v })} />
              </Field>
            </View>
          </View>

          {/* Live duration preview */}
          {absenceForm.fromDate && absenceForm.toDate && absenceForm.toDate >= absenceForm.fromDate && (() => {
            const d1 = new Date(absenceForm.fromDate);
            const d2 = new Date(absenceForm.toDate);
            const days = Math.floor((d2.getTime() - d1.getTime()) / 86400000) + 1;
            return (
              <View style={{ backgroundColor: days >= 30 ? '#DCFCE7' : '#FFEDD5', borderRadius: 10, padding: 10, marginBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name={days >= 30 ? 'checkmark-circle-outline' : 'time-outline'} size={16} color={days >= 30 ? '#16A34A' : '#EA580C'} />
                <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color: days >= 30 ? '#16A34A' : '#EA580C' }}>
                  {days} day{days !== 1 ? 's' : ''}{days >= 30 ? ' — qualifies for EB exclusion' : ' — minimum 30 days for EB exclusion'}
                </Text>
              </View>
            );
          })()}

          <Field label="Reason">
            <TextF value={absenceForm.reason} onChange={v => setAbsenceForm({ ...absenceForm, reason: v })} multiline placeholder="e.g. Home visit, medical leave…" />
          </Field>

          <ActionBtn
            title={absenceEditId ? 'Update Record' : 'Save Absence'}
            onPress={doSaveAbsence}
            loading={saving}
            disabled={!absenceForm.tenantId && !absenceEditId || !absenceForm.fromDate || !absenceForm.toDate}
          />
        </BottomSheet>
      </ScrollView>
    );
  }

  // ─── TAB RENDERER ─────────────────────────────────────────────────────────

  const tabContent: Record<string, () => React.JSX.Element> = {
    map:       renderBedMap,
    booking:   renderBooking,
    onboard:   renderOnboarding,
    switch:    renderSwitch,
    notices:   renderNotices,
    exit:      renderExit,
    payments:  renderPayments,
    refunds:   renderRefunds,
    absent:    renderAbsent,
  };

  if (loading) return <LoadingScreen />;

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header — web life-head */}
        <View style={{
          paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12,
          borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E8EDF5',
          backgroundColor: 'rgba(255,255,255,0.96)',
        }}>
          {anySheetOpen ? (
            <TouchableOpacity
              onPress={closeActiveSheet}
              activeOpacity={0.85}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'flex-start', paddingVertical: 4 }}>
              <View style={{
                width: 36, height: 36, borderRadius: 12,
                backgroundColor: '#fff',
                borderWidth: 1, borderColor: VBRAND.line,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons name="arrow-back" size={18} color={VBRAND.ink900} />
              </View>
              <View>
                <Text style={{ fontSize: 10, color: VBRAND.ink400, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' }}>
                  {TABS.find(t => t.key === activeTab)?.label || 'Lifecycle'}
                </Text>
                <Text style={{ fontSize: 17, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.3, marginTop: 1 }}>
                  {bookingOpen ? 'New Booking'
                    : cancelOpen ? 'Cancel Booking'
                    : onboardOpen ? 'Onboard Tenant'
                    : addPayOpen ? 'Add Payment'
                    : editOccOpen ? 'Edit Allotment'
                    : switchOpen ? 'Room Switch'
                    : noticeOpen ? 'Record Notice'
                    : editNoticeOpen ? 'Edit Notice'
                    : exitOpen ? 'Process Exit'
                    : editExitOpen ? 'Edit Exit'
                    : editRefundOpen ? 'Edit Refund'
                    : completeRefundOpen ? 'Complete Refund'
                    : absenceOpen ? (absenceEditId ? 'Edit Absence' : 'Add Absence')
                    : bedDetail ? `Bed ${bedDetail._apt?.apartment_code || ''}–${bedDetail.bed_code || ''}`
                    : 'Close'}
                </Text>
              </View>
            </TouchableOpacity>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 20, fontWeight: '800', color: VBRAND.ink900, letterSpacing: -0.3 }}>
                  Tenant Lifecycle
                </Text>
                <Text style={{ fontSize: 12, color: VBRAND.ink600, fontWeight: '600', marginTop: 2 }}>
                  Booking → Onboarding → Stay → Exit
                </Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => {
                    if (!activeTab) setBedFocusSearch(prev => prev);
                    Alert.alert('Search', 'Use the search field in the detail panel or module below.');
                  }}
                  style={{
                    width: 36, height: 36, borderRadius: 12,
                    backgroundColor: '#fff', borderWidth: 1, borderColor: VBRAND.line,
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Ionicons name="search-outline" size={18} color={VBRAND.purpleDeep} />
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => Alert.alert('Filter', 'Use Bed Status tiles or module tabs to filter.')}
                  style={{
                    width: 36, height: 36, borderRadius: 12,
                    backgroundColor: '#fff', borderWidth: 1, borderColor: VBRAND.line,
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Ionicons name="options-outline" size={18} color={VBRAND.purpleDeep} />
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Module icon tabs — web life-tabs-icons */}
        {!anySheetOpen && (
          <View>
            <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              {renderBedStatusCard()}
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 4 }}
              contentContainerStyle={{
                gap: 8, paddingVertical: 4, paddingHorizontal: 16,
              }}
            >
              {TABS.map(tab => {
                const active = activeTab === tab.key;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    onPress={() => selectModule(tab.key)}
                    activeOpacity={0.85}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
                      backgroundColor: active ? '#6A2C90' : '#F1F3F9',
                    }}
                  >
                    <Ionicons
                      name={tab.icon as any}
                      size={15}
                      color={active ? '#FFFFFF' : VBRAND.ink600}
                    />
                    <Text
                      style={{
                        fontSize: 12.5, fontWeight: active ? '800' : '600',
                        color: active ? '#FFFFFF' : VBRAND.ink600,
                      }}
                      numberOfLines={1}
                    >
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                onPress={() => Alert.alert('Excel Upload', 'Excel upload opened')}
                activeOpacity={0.85}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
                  backgroundColor: '#F1F3F9',
                }}
              >
                <Ionicons name="document-attach-outline" size={15} color={VBRAND.ink600} />
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: VBRAND.ink600 }}>
                  Excel Upload
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}

        {/* Module content OR bed-focus detail */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={VBRAND.purple} />}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {activeTab
            ? (tabContent[activeTab] || renderBedFocusDetail)()
            : renderBedFocusDetail()}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
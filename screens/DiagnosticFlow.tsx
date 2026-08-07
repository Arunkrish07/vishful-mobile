/**
 * screens/DiagnosticFlow.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 *  Stage 1 – questioning      : Auto-advancing Q&A (UNCHANGED)
 *  Stage 2 – ready_to_diagnose: "Run AI Diagnosis" prompt (UNCHANGED)
 *  Stage 3 – diagnosing       : Spinner while calling runAIDiagnosis (UNCHANGED)
 *  Stage 4 – result           : AI causes + Custom diagnosis (UNCHANGED)
 *  Stage 5 – cost_options     : 3 cost estimate tier cards  ← NEW
 *  Stage 6 – parts_approval   : Editable parts list + Submit ← NEW (replaces old parts_approval)
 *
 * Submit sends the cost estimate to the org's configured cost approver(s)
 * (fetched via sb.getCostApprovers()) — no hardcoded approver.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/ThemeContext';
import { useAuth } from '../lib/auth';
import { client, api } from '../lib/convexApi';
import { saveTicketResolution } from '../services/ticketService';
import * as sb from '../lib/supabaseService';

const BRAND = '#E8841A';
const BRAND_LIGHT = 'rgba(232,132,26,0.12)';

// ─── Diagnostic questions (UNCHANGED) ────────────────────────────────────────
interface DiagOption   { value: string; label: string }
interface DiagQuestion { question: string; options: DiagOption[] }

function getDiagnosticQuestions(issueType: string, subType?: string | null): DiagQuestion[] {
  const type = (issueType || '').toLowerCase();
  const sub  = (subType  || '').toLowerCase();
  if ((type || '').includes('plumb') || (type || '').includes('water') || (sub || '').includes('leak')) {
    return [
      { question: 'Where is the water issue located?',
        options: [{ value:'bathroom',label:'Bathroom'},{value:'kitchen',label:'Kitchen'},{value:'balcony',label:'Balcony'},{value:'other',label:'Other'}]},
      { question: 'How severe is the leak?',
        options: [{value:'drip',label:'Slow drip'},{value:'moderate',label:'Steady flow'},{value:'burst',label:'Burst / heavy flow'}]},
      { question: 'How long has the issue been present?',
        options: [{value:'today',label:'Just noticed today'},{value:'days',label:'A few days'},{value:'weeks',label:'More than a week'}]},
      { question: 'Is there visible water damage?',
        options: [{value:'none',label:'No visible damage'},{value:'stain',label:'Water stains / damp'},{value:'ceiling',label:'Ceiling / wall damage'}]},
    ];
  }
  if ((type || '').includes('electric') || (sub || '').includes('power') || (sub || '').includes('wiring')) {
    return [
      { question: 'What is the primary symptom?',
        options: [{value:'no_power',label:'No power in area'},{value:'tripping',label:'Breaker keeps tripping'},{value:'sparks',label:'Sparks / burning smell'},{value:'flickering',label:'Lights flickering'}]},
      { question: 'Which area is affected?',
        options: [{value:'single',label:'Single outlet / switch'},{value:'room',label:'Entire room'},{value:'flat',label:'Entire apartment'}]},
      { question: 'Are any appliances damaged?',
        options: [{value:'none',label:'No appliance issues'},{value:'minor',label:'One appliance affected'},{value:'major',label:'Multiple appliances'}]},
    ];
  }
  if ((type || '').includes('ac') || (type || '').includes('air con') || (sub || '').includes('cooling')) {
    return [
      { question: 'What is the AC symptom?',
        options: [{value:'not_cooling',label:'Not cooling'},{value:'no_power',label:'Not turning on'},{value:'noise',label:'Unusual noise'},{value:'water',label:'Water dripping / leaking'}]},
      { question: 'When does the issue occur?',
        options: [{value:'always',label:'Continuously'},{value:'startup',label:'On startup only'},{value:'after_use',label:'After extended use'}]},
      { question: 'Last serviced approximately?',
        options: [{value:'recent',label:'Within 3 months'},{value:'year',label:'3-12 months ago'},{value:'long',label:'Over a year / unknown'}]},
    ];
  }
  if ((type || '').includes('carp') || (type || '').includes('furniture') || (sub || '').includes('door') || (sub || '').includes('window')) {
    return [
      { question: 'What is affected?',
        options: [{value:'door',label:'Door'},{value:'window',label:'Window'},{value:'cabinet',label:'Cabinet / shelf'},{value:'other',label:'Other fixture'}]},
      { question: 'Describe the issue:',
        options: [{value:'broken',label:'Broken / cracked'},{value:'stiff',label:'Stiff / not closing'},{value:'loose',label:'Loose / wobbly'},{value:'missing',label:'Missing hardware'}]},
    ];
  }
  return [
    { question: 'How long has this issue been present?',
      options: [{value:'today',label:'Just noticed'},{value:'days',label:'A few days'},{value:'weeks',label:'More than a week'}]},
    { question: 'How would you rate the severity?',
      options: [{value:'minor',label:'Minor - can wait'},{value:'moderate',label:'Moderate - affects use'},{value:'urgent',label:'Urgent - safety risk'}]},
    { question: 'Has this happened before?',
      options: [{value:'first',label:'First time'},{value:'recurring',label:'Recurring issue'},{value:'unknown',label:'Not sure'}]},
  ];
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface RequiredPart  { name: string; estimatedPrice: string }
interface DiagnosticCause {
  cause: string; probability: number; severity: 'low'|'medium'|'high';
  solution: string; estimatedCost: string; requiredParts?: RequiredPart[];
}
interface DiagnosisResult { causes: DiagnosticCause[]; summary: string; urgency: string; recommendedAction: string }
interface QA       { question: string; answer: string }
interface PartItem { item_name: string; cost_type: string; quantity: number; unit_price: number }

export interface DiagnosticFlowResult {
  answers: QA[];
  result: { cause: string; severity: string; estimatedCost: string; recommendation: string };
  fullDiagnosis?: DiagnosisResult;
  parts?: PartItem[];
  submitForApproval?: boolean;
}

interface Props {
  issueTypeName: string; issueTypeId: string; ticketId: string; issueSubType?: string|null;
  onComplete: (result: DiagnosticFlowResult) => void;
  onNoCostComplete?: () => void;
  onCancel: () => void;
}

// ─── Cost tier definitions ────────────────────────────────────────────────────
interface CostTier {
  id: 'basic'|'standard'|'premium'; label: string; tagline: string;
  accentColor: string; accentBg: string; accentBorder: string;
  icon: string; badge?: string; multiplier: number;
}
const COST_TIERS: CostTier[] = [
  { id:'basic',    label:'Basic',    tagline:'Essential repair only',       accentColor:'#16A34A', accentBg:'rgba(22,163,74,0.08)',   accentBorder:'rgba(22,163,74,0.25)',   icon:'build-outline',            multiplier:0.7 },
  { id:'standard', label:'Standard', tagline:'Recommended solution',        accentColor:BRAND,     accentBg:BRAND_LIGHT,              accentBorder:'rgba(232,132,26,0.35)', icon:'star-outline',             badge:'RECOMMENDED', multiplier:1.0 },
  { id:'premium',  label:'Premium',  tagline:'Full fix + preventive care',  accentColor:'#7C3AED', accentBg:'rgba(124,58,237,0.08)',  accentBorder:'rgba(124,58,237,0.25)', icon:'shield-checkmark-outline', multiplier:1.4 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const SEVERITY_COLOR: Record<string,{text:string;bg:string}> = {
  low:{text:'#16A34A',bg:'#DCFCE7'}, medium:{text:'#D97706',bg:'#FEF3C7'}, high:{text:'#DC2626',bg:'#FEE2E2'},
};
const URGENCY_COLOR: Record<string,{border:string;bg:string}> = {
  low:{border:'#86EFAC',bg:'rgba(34,197,94,0.06)'}, medium:{border:'#FCD34D',bg:'rgba(217,119,6,0.06)'},
  high:{border:'#FCA5A5',bg:'rgba(220,38,38,0.06)'}, critical:{border:'#EF4444',bg:'rgba(220,38,38,0.10)'},
};

function parseCostMidpoint(s: string): number {
  const nums = (s||'').replace(/,/g,'').match(/\d+(\.\d+)?/g);
  if (!nums||nums.length===0) return 1000;
  if (nums.length===1) return parseFloat(nums[0]);
  return Math.round((parseFloat(nums[0])+parseFloat(nums[nums.length-1]))/2);
}

function buildTierParts(aiParts: RequiredPart[], cause: DiagnosticCause, tier: CostTier): PartItem[] {
  if (aiParts.length > 0) {
    const items: PartItem[] = aiParts.map(p => ({
      item_name: p.name, cost_type:'parts', quantity:1,
      unit_price: Math.round(parseCostMidpoint(p.estimatedPrice) * tier.multiplier),
    }));
    if (tier.id !== 'basic') {
      const base = parseCostMidpoint(cause.estimatedCost);
      items.push({ item_name: tier.id==='premium'?'Labour + Inspection':'Labour charges', cost_type:'labor', quantity:1, unit_price:Math.round(base*0.25*tier.multiplier) });
    }
    return items;
  }
  const base = parseCostMidpoint(cause.estimatedCost);
  const items: PartItem[] = [
    { item_name:'Materials & parts', cost_type:'parts', quantity:1, unit_price:Math.round(base*0.6*tier.multiplier) },
    { item_name:'Labour charges',    cost_type:'labor', quantity:1, unit_price:Math.round(base*0.4*tier.multiplier) },
  ];
  if (tier.id==='premium') items.push({ item_name:'Preventive inspection', cost_type:'labor', quantity:1, unit_price:Math.round(base*0.2) });
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
type Stage = 'questioning'|'ready_to_diagnose'|'diagnosing'|'result'|'cost_options'|'parts_approval';

export function DiagnosticFlow({ issueTypeName, issueTypeId, ticketId, issueSubType, onComplete, onNoCostComplete, onCancel }: Props) {
  const { colors } = useTheme();
  const { user } = useAuth();
  // Actor performing the diagnosis/cost/completion — must be the signed-in
  // technician, NOT the hardcoded approver id (see COST_APPROVER_USER_ID note).
  const actorId = user?.supabaseUserId || user?.userId || '';
  const allQuestions = getDiagnosticQuestions(issueTypeName, issueSubType);

  const [stage, setStage]                   = useState<Stage>('questioning');
  const [questionIndex, setQuestionIndex]   = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState('');
  const [answers, setAnswers]               = useState<QA[]>([]);
  const [diagnosis, setDiagnosis]           = useState<DiagnosisResult|null>(null);
  const [selectedCause, setSelectedCause]   = useState<DiagnosticCause|null>(null);
  const [diagChoice, setDiagChoice]         = useState<'ai'|'custom'>('ai');
  const [customProblem, setCustomProblem]   = useState('');
  const [customSolution, setCustomSolution] = useState('');
  const [customEstimate, setCustomEstimate] = useState('');
  const [selectedTier, setSelectedTier]     = useState<CostTier|null>(null);
  const [noCostSelected, setNoCostSelected] = useState(false);
  const [confirmedDiag, setConfirmedDiag]   = useState<DiagnosticFlowResult['result']|null>(null);
  const [parts, setParts]                   = useState<PartItem[]>([]);
  const [submitting, setSubmitting]         = useState(false);
  const [approverName, setApproverName]     = useState('');

  // Fetch the org's configured cost approver so the parts-approval notice shows a
  // real name instead of a hardcoded one. Falls back to a generic label if the
  // approver row carries no name field.
  useEffect(() => {
    let active = true;
    sb.getCostApprovers()
      .then((rows: any) => {
        if (!active || !Array.isArray(rows) || rows.length === 0) return;
        const a = rows[0];
        const name = a?.approver_name || a?.name || a?.full_name || '';
        if (name) setApproverName(name);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const currentQuestion = questionIndex < allQuestions.length ? allQuestions[questionIndex] : null;
  const validParts = parts.filter(p => p.item_name.trim());
  const totalCost  = validParts.reduce((s,p) => s+p.quantity*p.unit_price, 0);

  function handleAnswerSelect(val: string) {
    if (selectedAnswer) return;
    setSelectedAnswer(val);
    const option = currentQuestion?.options.find(o => o.value===val);
    if (!option||!currentQuestion) return;
    setTimeout(() => {
      const newAnswers = [...answers, { question:currentQuestion.question, answer:option.label }];
      setAnswers(newAnswers); setSelectedAnswer('');
      if (questionIndex+1 >= allQuestions.length) setStage('ready_to_diagnose');
      else setQuestionIndex(p => p+1);
    }, 350);
  }

  async function runDiagnosis() {
    setStage('diagnosing');
    try {
      const result = await client.action(api.runAIDiagnosis.runAIDiagnosis, { ticketId, issueTypeId, issueSubType:issueSubType||undefined, answers });
      setDiagnosis(result as DiagnosisResult);
      if ((result as DiagnosisResult).causes?.length > 0) setSelectedCause((result as DiagnosisResult).causes[0]);
      setStage('result');
    } catch (e: any) {
      Alert.alert('Diagnosis failed', e?.message||'Unknown error');
      setStage('ready_to_diagnose');
    }
  }

  function handleConfirmAndContinue() {
    let diagResult: DiagnosticFlowResult['result'];
    if (diagChoice==='ai' && selectedCause) {
      diagResult = { cause:selectedCause.cause, severity:selectedCause.severity, estimatedCost:selectedCause.estimatedCost, recommendation:selectedCause.solution };
    } else if (diagChoice==='custom') {
      if (!customProblem.trim()||!customSolution.trim()) { Alert.alert('Required','Fill in both fields.'); return; }
      const estCost = customEstimate.trim() ? `₹${customEstimate.trim()}` : 'To be determined';
      diagResult = { cause:customProblem, severity:'medium', estimatedCost:estCost, recommendation:customSolution };
    } else { return; }
    setConfirmedDiag(diagResult);
    setNoCostSelected(false);
    const std = COST_TIERS.find(t => t.id==='standard')!;
    setSelectedTier(std);
    if (selectedCause) setParts(buildTierParts(selectedCause.requiredParts||[], selectedCause, std));
    setStage('cost_options');
  }

  function handleSelectTier(tier: CostTier) {
    setNoCostSelected(false);
    setSelectedTier(tier);
    if (selectedCause) setParts(buildTierParts(selectedCause.requiredParts||[], selectedCause, tier));
    else if (confirmedDiag) {
      const base = parseCostMidpoint(confirmedDiag.estimatedCost);
      setParts([
        { item_name:'Materials & parts', cost_type:'parts', quantity:1, unit_price:Math.round(base*0.6*tier.multiplier) },
        { item_name:'Labour charges',    cost_type:'labor', quantity:1, unit_price:Math.round(base*0.4*tier.multiplier) },
      ]);
    }
  }

  function addPart()  { setParts(p => [...p, { item_name:'', cost_type:'parts', quantity:1, unit_price:0 }]); }
  function removePart(idx: number) { setParts(p => p.filter((_,i) => i!==idx)); }
  function updatePart(idx: number, key: keyof PartItem, val: any) { setParts(p => p.map((it,i) => i===idx ? {...it,[key]:val} : it)); }

  async function handleNoCostSubmit() {
    if (!confirmedDiag) return;
    setSubmitting(true);
    try {
      // Write a minimal resolution row (mirrors the "Mark Complete" flow) instead
      // of only flipping status — no-cost closures previously left no
      // ticket_resolutions record. saveResolution also routes the ticket to the
      // correct pending-approval status. Capture a brief closure summary from the
      // confirmed diagnosis so there is a record of what was done.
      const closureSummary =
        [confirmedDiag.cause, confirmedDiag.recommendation].filter(Boolean).join('. ').trim()
        || 'Resolved on site — no additional parts or cost required.';
      await saveTicketResolution({
        ticketId,
        userId:         actorId,
        resolutionType: 'inhouse',
        serviceType:    'repair',
        closureSummary,
      });
      if (onNoCostComplete) onNoCostComplete();
      else onComplete({ answers, result: confirmedDiag, fullDiagnosis: diagnosis||undefined, parts: [], submitForApproval: false });
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to mark complete');
    } finally { setSubmitting(false); }
  }

  function handleFinalSubmit() {
    if (!confirmedDiag) return;
    if (validParts.length===0) { Alert.alert('Add Parts','Add at least one part to submit.'); return; }
    // NOTE: do NOT submit cost estimates here. The parent opens the CostEstimateReviewModal
    // (pre-filled from these parts) which is the single submit point + shows the auto-approve
    // threshold preview. Submitting here caused duplicate estimate rows / doubled totals.
    onComplete({ answers, result:confirmedDiag, fullDiagnosis:diagnosis||undefined, parts:validParts, submitForApproval:true });
  }

  function handleReset() {
    setStage('questioning'); setQuestionIndex(0); setSelectedAnswer(''); setAnswers([]);
    setDiagnosis(null); setSelectedCause(null); setDiagChoice('ai'); setCustomProblem(''); setCustomSolution(''); setCustomEstimate('');
    setSelectedTier(null); setNoCostSelected(false); setConfirmedDiag(null); setParts([]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <ScrollView contentContainerStyle={{ gap:14, paddingBottom:20 }} showsVerticalScrollIndicator={false}>

      {/* Answered questions trail */}
      {answers.length>0 && !['parts_approval','cost_options'].includes(stage) && (
        <View style={{ gap:8 }}>
          {answers.map((a,i) => (
            <View key={i} style={{ backgroundColor:colors.surface, borderRadius:12, padding:12, borderWidth:1, borderColor:colors.border }}>
              <Text style={{ fontSize:11, color:colors.textTertiary }}>{a.question}</Text>
              <View style={{ flexDirection:'row', alignItems:'center', gap:6, marginTop:4 }}>
                <Ionicons name="checkmark-circle" size={13} color={BRAND} />
                <Text style={{ fontSize:13, fontWeight:'700', color:colors.text }}>{a.answer}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ── Stage: questioning ─────────────────────────────────────────── */}
      {stage==='questioning' && currentQuestion && (
        <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:16, borderWidth:1.5, borderColor:`${BRAND}40` }}>
          <View style={{ flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
            <Text style={{ fontSize:14, fontWeight:'700', color:colors.text, flex:1, marginRight:10 }}>{currentQuestion.question}</Text>
            <View style={{ backgroundColor:BRAND_LIGHT, borderRadius:999, paddingHorizontal:8, paddingVertical:3 }}>
              <Text style={{ fontSize:10, fontWeight:'800', color:BRAND }}>{questionIndex+1}/{allQuestions.length}</Text>
            </View>
          </View>
          <View style={{ gap:8 }}>
            {currentQuestion.options.map(opt => {
              const isSel = selectedAnswer===opt.value;
              return (
                <TouchableOpacity key={opt.value} onPress={() => handleAnswerSelect(opt.value)} activeOpacity={0.75}
                  style={{ flexDirection:'row', alignItems:'center', gap:12, padding:13, borderRadius:12,
                    backgroundColor:isSel ? BRAND_LIGHT:(colors.background||colors.surface),
                    borderWidth:1.5, borderColor:isSel ? BRAND:colors.border }}>
                  <View style={{ width:20,height:20,borderRadius:10,borderWidth:2,
                    borderColor:isSel?BRAND:colors.border, backgroundColor:isSel?BRAND:'transparent',
                    alignItems:'center',justifyContent:'center' }}>
                    {isSel && <View style={{ width:8,height:8,borderRadius:4,backgroundColor:'#fff' }} />}
                  </View>
                  <Text style={{ fontSize:14, color:colors.text, flex:1 }}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* ── Stage: ready_to_diagnose ───────────────────────────────────── */}
      {stage==='ready_to_diagnose' && (
        <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:20, borderWidth:1.5, borderColor:`${BRAND}40`, alignItems:'center' }}>
          <View style={{ width:56,height:56,borderRadius:18,backgroundColor:BRAND_LIGHT,alignItems:'center',justifyContent:'center',marginBottom:12 }}>
            <Ionicons name="hardware-chip-outline" size={28} color={BRAND} />
          </View>
          <Text style={{ fontSize:15, fontWeight:'800', color:colors.text, marginBottom:6 }}>Ready to Analyse</Text>
          <Text style={{ fontSize:13, color:colors.textSecondary, textAlign:'center', marginBottom:18 }}>
            AI will review your responses and suggest root causes, solutions, and cost estimates.
          </Text>
          <View style={{ flexDirection:'row', gap:10 }}>
            <TouchableOpacity onPress={runDiagnosis}
              style={{ flexDirection:'row',alignItems:'center',gap:8,backgroundColor:BRAND,borderRadius:14,paddingHorizontal:20,paddingVertical:12 }}>
              <Ionicons name="medical-outline" size={18} color="#fff" />
              <Text style={{ fontSize:14, fontWeight:'800', color:'#fff' }}>Run Diagnosis</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleReset}
              style={{ flexDirection:'row',alignItems:'center',gap:6,borderWidth:1.5,borderColor:colors.border,borderRadius:14,paddingHorizontal:14,paddingVertical:12 }}>
              <Ionicons name="refresh-outline" size={16} color={colors.textSecondary} />
              <Text style={{ fontSize:13, fontWeight:'700', color:colors.textSecondary }}>Restart</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Stage: diagnosing ──────────────────────────────────────────── */}
      {stage==='diagnosing' && (
        <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:32, borderWidth:1, borderColor:`${BRAND}30`, alignItems:'center' }}>
          <View style={{ position:'relative', marginBottom:16 }}>
            <Ionicons name="hardware-chip-outline" size={40} color={`${BRAND}50`} />
            <ActivityIndicator size="small" color={BRAND} style={{ position:'absolute', top:-4, right:-8 }} />
          </View>
          <Text style={{ fontSize:14, fontWeight:'700', color:colors.text }}>Running AI Diagnosis...</Text>
          <Text style={{ fontSize:12, color:colors.textTertiary, marginTop:4 }}>This may take a few seconds</Text>
        </View>
      )}

      {/* ── Stage: result ──────────────────────────────────────────────── */}
      {stage==='result' && diagnosis && (
        <View style={{ gap:14 }}>
          {(() => {
            const uc = URGENCY_COLOR[diagnosis.urgency]||URGENCY_COLOR.medium;
            return (
              <View style={{ backgroundColor:uc.bg, borderRadius:16, padding:16, borderWidth:1.5, borderColor:uc.border }}>
                <View style={{ flexDirection:'row', alignItems:'center', gap:8, marginBottom:10 }}>
                  <Ionicons name="hardware-chip-outline" size={16} color={BRAND} />
                  <Text style={{ fontSize:13, fontWeight:'800', color:colors.text }}>AI Diagnosis Summary</Text>
                </View>
                <Text style={{ fontSize:14, color:colors.text, lineHeight:20, marginBottom:10 }}>{diagnosis.summary}</Text>
                <View style={{ flexDirection:'row', alignItems:'center', gap:8 }}>
                  <Text style={{ fontSize:11, color:colors.textTertiary }}>Urgency:</Text>
                  <View style={{ backgroundColor:(SEVERITY_COLOR[diagnosis.urgency]||SEVERITY_COLOR.medium).bg, borderRadius:999, paddingHorizontal:10, paddingVertical:3 }}>
                    <Text style={{ fontSize:10, fontWeight:'800', color:(SEVERITY_COLOR[diagnosis.urgency]||SEVERITY_COLOR.medium).text }}>{diagnosis.urgency.toUpperCase()}</Text>
                  </View>
                </View>
              </View>
            );
          })()}

          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:16, borderWidth:1, borderColor:colors.border }}>
            <Text style={{ fontSize:13, fontWeight:'800', color:colors.text, marginBottom:14 }}>Select Diagnosis Type</Text>

            {/* AI Option */}
            <TouchableOpacity onPress={() => setDiagChoice('ai')}
              style={{ borderRadius:14, borderWidth:1.5, borderColor:diagChoice==='ai'?BRAND:colors.border, backgroundColor:diagChoice==='ai'?BRAND_LIGHT:colors.surface, padding:14, marginBottom:10 }}>
              <View style={{ flexDirection:'row', alignItems:'center', gap:10, marginBottom:diagChoice==='ai'?14:0 }}>
                <View style={{ width:20,height:20,borderRadius:10,borderWidth:2, borderColor:diagChoice==='ai'?BRAND:colors.border, backgroundColor:diagChoice==='ai'?BRAND:'transparent', alignItems:'center',justifyContent:'center' }}>
                  {diagChoice==='ai' && <View style={{ width:8,height:8,borderRadius:4,backgroundColor:'#fff' }} />}
                </View>
                <Ionicons name="hardware-chip-outline" size={16} color={diagChoice==='ai'?BRAND:colors.textSecondary} />
                <Text style={{ fontSize:14, fontWeight:'700', color:colors.text }}>AI Suggested Diagnosis</Text>
              </View>
              {diagChoice==='ai' && (
                <View style={{ gap:10, marginLeft:30 }}>
                  {diagnosis.causes.map((cause,i) => {
                    const sev = SEVERITY_COLOR[cause.severity]||SEVERITY_COLOR.medium;
                    const isSel = selectedCause?.cause===cause.cause;
                    return (
                      <TouchableOpacity key={i} onPress={() => setSelectedCause(cause)}
                        style={{ borderRadius:12, padding:12, borderWidth:1.5, borderColor:isSel?BRAND:colors.border, backgroundColor:isSel?`${BRAND}10`:(colors.background||colors.surface) }}>
                        <View style={{ flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between' }}>
                          <View style={{ flex:1, marginRight:8 }}>
                            <View style={{ flexDirection:'row', alignItems:'center', gap:8, marginBottom:4 }}>
                              <Text style={{ fontSize:13, fontWeight:'800', color:colors.text }}>{cause.cause}</Text>
                              <View style={{ backgroundColor:sev.bg, borderRadius:999, paddingHorizontal:8, paddingVertical:2 }}>
                                <Text style={{ fontSize:9, fontWeight:'800', color:sev.text }}>{cause.severity.toUpperCase()}</Text>
                              </View>
                            </View>
                            <Text style={{ fontSize:12, color:colors.textSecondary, lineHeight:18 }}>{cause.solution}</Text>
                          </View>
                          <View style={{ alignItems:'flex-end' }}>
                            <Text style={{ fontSize:20, fontWeight:'800', color:BRAND }}>{cause.probability}%</Text>
                            <Text style={{ fontSize:9, color:colors.textTertiary }}>probability</Text>
                          </View>
                        </View>
                        <View style={{ flexDirection:'row', alignItems:'center', gap:4, marginTop:8 }}>
                          <Ionicons name="cash-outline" size={12} color={colors.textTertiary} />
                          <Text style={{ fontSize:11, color:colors.textSecondary }}>{cause.estimatedCost}</Text>
                        </View>
                        {cause.requiredParts && cause.requiredParts.length>0 && (
                          <View style={{ marginTop:8 }}>
                            <Text style={{ fontSize:10, color:colors.textTertiary, marginBottom:4 }}>Suggested Parts:</Text>
                            <View style={{ flexDirection:'row', flexWrap:'wrap', gap:6 }}>
                              {cause.requiredParts.map((p,pi) => (
                                <View key={pi} style={{ borderWidth:1, borderColor:colors.border, borderRadius:999, paddingHorizontal:8, paddingVertical:2 }}>
                                  <Text style={{ fontSize:9, color:colors.textSecondary }}>{p.name} — {p.estimatedPrice}</Text>
                                </View>
                              ))}
                            </View>
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </TouchableOpacity>

            {/* Custom Option */}
            <TouchableOpacity onPress={() => setDiagChoice('custom')}
              style={{ borderRadius:14, borderWidth:1.5, borderColor:diagChoice==='custom'?BRAND:colors.border, backgroundColor:diagChoice==='custom'?BRAND_LIGHT:colors.surface, padding:14 }}>
              <View style={{ flexDirection:'row', alignItems:'center', gap:10, marginBottom:diagChoice==='custom'?14:0 }}>
                <View style={{ width:20,height:20,borderRadius:10,borderWidth:2, borderColor:diagChoice==='custom'?BRAND:colors.border, backgroundColor:diagChoice==='custom'?BRAND:'transparent', alignItems:'center',justifyContent:'center' }}>
                  {diagChoice==='custom' && <View style={{ width:8,height:8,borderRadius:4,backgroundColor:'#fff' }} />}
                </View>
                <Ionicons name="document-text-outline" size={16} color={diagChoice==='custom'?BRAND:colors.textSecondary} />
                <Text style={{ fontSize:14, fontWeight:'700', color:colors.text }}>Custom Diagnosis</Text>
              </View>
              {diagChoice==='custom' && (
                <View style={{ marginLeft:30, gap:12 }}>
                  <View style={{ gap:4 }}>
                    <Text style={{ fontSize:11, fontWeight:'700', color:colors.textTertiary, letterSpacing:0.4 }}>PROBLEM *</Text>
                    <TextInput value={customProblem} onChangeText={setCustomProblem} placeholder="Describe the problem..." placeholderTextColor={colors.textTertiary} multiline
                      style={{ backgroundColor:colors.background||colors.surface, borderWidth:1, borderColor:colors.border, borderRadius:12, padding:12, fontSize:14, color:colors.text, minHeight:72, textAlignVertical:'top' }} />
                  </View>
                  <View style={{ gap:4 }}>
                    <Text style={{ fontSize:11, fontWeight:'700', color:colors.textTertiary, letterSpacing:0.4 }}>RECOMMENDED SOLUTION *</Text>
                    <TextInput value={customSolution} onChangeText={setCustomSolution} placeholder="Describe the recommended solution..." placeholderTextColor={colors.textTertiary} multiline
                      style={{ backgroundColor:colors.background||colors.surface, borderWidth:1, borderColor:colors.border, borderRadius:12, padding:12, fontSize:14, color:colors.text, minHeight:72, textAlignVertical:'top' }} />
                  </View>
                  <View style={{ gap:4 }}>
                    <Text style={{ fontSize:11, fontWeight:'700', color:colors.textTertiary, letterSpacing:0.4 }}>ESTIMATED COST (₹) <Text style={{ fontWeight:'400' }}>— optional, helps generate tier pricing</Text></Text>
                    <TextInput value={customEstimate} onChangeText={setCustomEstimate} placeholder="e.g. 1500" placeholderTextColor={colors.textTertiary} keyboardType="numeric"
                      style={{ backgroundColor:colors.background||colors.surface, borderWidth:1, borderColor:colors.border, borderRadius:12, padding:12, fontSize:14, color:colors.text }} />
                  </View>
                </View>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={handleConfirmAndContinue}
              disabled={(diagChoice==='ai'&&!selectedCause)||(diagChoice==='custom'&&(!customProblem.trim()||!customSolution.trim()))}
              style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8, backgroundColor:BRAND, borderRadius:14, padding:14, marginTop:14,
                opacity:(diagChoice==='ai'&&!selectedCause)||(diagChoice==='custom'&&(!customProblem.trim()||!customSolution.trim()))?0.45:1 }}>
              <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
              <Text style={{ fontSize:15, fontWeight:'800', color:'#fff' }}>Confirm Problem & Continue</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleReset}
              style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6, borderWidth:1.5, borderColor:colors.border, borderRadius:14, padding:12, marginTop:8 }}>
              <Ionicons name="refresh-outline" size={15} color={colors.textSecondary} />
              <Text style={{ fontSize:13, fontWeight:'700', color:colors.textSecondary }}>Redo Diagnosis</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          Stage 5 – COST OPTIONS  (3 tier cards)
      ════════════════════════════════════════════════════════════════════ */}
      {stage==='cost_options' && confirmedDiag && (
        <View style={{ gap:14 }}>

          {/* Header */}
          <View style={{ alignItems:'center', paddingVertical:6 }}>
            <View style={{ width:48,height:48,borderRadius:14,backgroundColor:BRAND_LIGHT,alignItems:'center',justifyContent:'center',marginBottom:8 }}>
              <Ionicons name="receipt-outline" size={24} color={BRAND} />
            </View>
            <Text style={{ fontSize:17, fontWeight:'800', color:colors.text }}>Cost Estimate Options</Text>
            <Text style={{ fontSize:12, color:colors.textSecondary, marginTop:4, textAlign:'center' }}>
              Choose a repair tier — then review and customise the parts list
            </Text>
          </View>

          {/* Confirmed diagnosis pill */}
          <View style={{ flexDirection:'row', alignItems:'center', gap:8, backgroundColor:'rgba(34,197,94,0.08)', borderRadius:12, padding:12, borderWidth:1, borderColor:'rgba(34,197,94,0.25)' }}>
            <Ionicons name="checkmark-circle" size={16} color="#22C55E" />
            <View style={{ flex:1 }}>
              <Text style={{ fontSize:11, color:'#16A34A', fontWeight:'700' }}>CONFIRMED ISSUE</Text>
              <Text style={{ fontSize:13, fontWeight:'700', color:colors.text }}>{confirmedDiag.cause}</Text>
            </View>
          </View>

          {/* 3 tier cards */}
          {COST_TIERS.map(tier => {
            const tierParts = selectedCause ? buildTierParts(selectedCause.requiredParts||[], selectedCause, tier) : [];
            const tierTotal = tierParts.reduce((s,p) => s+p.quantity*p.unit_price, 0);
            const isSel = !noCostSelected && selectedTier?.id===tier.id;
            return (
              <TouchableOpacity key={tier.id} onPress={() => handleSelectTier(tier)} activeOpacity={0.8}
                style={{ borderRadius:18, borderWidth:isSel?2:1, borderColor:isSel?tier.accentColor:colors.border, backgroundColor:isSel?tier.accentBg:colors.surface, overflow:'hidden' }}>
                {/* Card header */}
                <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:16, paddingVertical:14, borderBottomWidth:1, borderBottomColor:isSel?tier.accentBorder:colors.border }}>
                  <View style={{ flexDirection:'row', alignItems:'center', gap:10 }}>
                    <View style={{ width:36,height:36,borderRadius:10, backgroundColor:isSel?tier.accentColor:(colors.background||colors.surface), alignItems:'center',justifyContent:'center', borderWidth:1, borderColor:isSel?'transparent':colors.border }}>
                      <Ionicons name={tier.icon as any} size={18} color={isSel?'#fff':tier.accentColor} />
                    </View>
                    <View>
                      <View style={{ flexDirection:'row', alignItems:'center', gap:6 }}>
                        <Text style={{ fontSize:15, fontWeight:'800', color:isSel?tier.accentColor:colors.text }}>{tier.label}</Text>
                        {tier.badge && (
                          <View style={{ backgroundColor:tier.accentColor, borderRadius:999, paddingHorizontal:7, paddingVertical:2 }}>
                            <Text style={{ fontSize:8, fontWeight:'800', color:'#fff', letterSpacing:0.5 }}>{tier.badge}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={{ fontSize:11, color:colors.textSecondary }}>{tier.tagline}</Text>
                    </View>
                  </View>
                  <View style={{ alignItems:'flex-end' }}>
                    <Text style={{ fontSize:20, fontWeight:'800', color:isSel?tier.accentColor:colors.text }}>
                      ₹{tierTotal.toLocaleString('en-IN')}
                    </Text>
                    <Text style={{ fontSize:9, color:colors.textTertiary }}>EST. TOTAL</Text>
                  </View>
                </View>
                {/* Parts preview */}
                <View style={{ padding:14, gap:6 }}>
                  {tierParts.slice(0,3).map((p,pi) => (
                    <View key={pi} style={{ flexDirection:'row', alignItems:'center', justifyContent:'space-between' }}>
                      <View style={{ flexDirection:'row', alignItems:'center', gap:6, flex:1 }}>
                        <View style={{ width:6,height:6,borderRadius:3, backgroundColor:p.cost_type==='labor'?'#7C3AED':tier.accentColor }} />
                        <Text style={{ fontSize:12, color:colors.text, flex:1 }} numberOfLines={1}>{p.item_name}</Text>
                      </View>
                      <Text style={{ fontSize:12, fontWeight:'700', color:colors.textSecondary }}>₹{(p.quantity*p.unit_price).toLocaleString('en-IN')}</Text>
                    </View>
                  ))}
                  {tierParts.length>3 && <Text style={{ fontSize:11, color:colors.textTertiary }}>+ {tierParts.length-3} more items…</Text>}
                </View>
                {/* Selected bar */}
                {isSel && (
                  <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, backgroundColor:tier.accentColor, paddingVertical:8 }}>
                    <Ionicons name="checkmark-circle" size={14} color="#fff" />
                    <Text style={{ fontSize:12, fontWeight:'800', color:'#fff' }}>Selected — tap below to customise</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}

          {/* No Cost card */}
          <TouchableOpacity onPress={() => { setNoCostSelected(true); setSelectedTier(null); setParts([]); }} activeOpacity={0.8}
            style={{ borderRadius:18, borderWidth:noCostSelected?2:1, borderColor:noCostSelected?'#22C55E':colors.border, backgroundColor:noCostSelected?'rgba(34,197,94,0.07)':colors.surface, overflow:'hidden' }}>
            <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:16, paddingVertical:14 }}>
              <View style={{ flexDirection:'row', alignItems:'center', gap:10 }}>
                <View style={{ width:36,height:36,borderRadius:10, backgroundColor:noCostSelected?'#22C55E':(colors.background||colors.surface), alignItems:'center',justifyContent:'center', borderWidth:1, borderColor:noCostSelected?'transparent':colors.border }}>
                  <Ionicons name="checkmark-done-circle-outline" size={18} color={noCostSelected?'#fff':'#22C55E'} />
                </View>
                <View>
                  <Text style={{ fontSize:15, fontWeight:'800', color:noCostSelected?'#22C55E':colors.text }}>No Cost</Text>
                  <Text style={{ fontSize:11, color:colors.textSecondary }}>No parts or materials needed</Text>
                </View>
              </View>
              <View style={{ alignItems:'flex-end' }}>
                <Text style={{ fontSize:20, fontWeight:'800', color:noCostSelected?'#22C55E':colors.text }}>₹0</Text>
                <Text style={{ fontSize:9, color:colors.textTertiary }}>NO CHARGE</Text>
              </View>
            </View>
            {noCostSelected && (
              <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, backgroundColor:'#22C55E', paddingVertical:8 }}>
                <Ionicons name="checkmark-circle" size={14} color="#fff" />
                <Text style={{ fontSize:12, fontWeight:'800', color:'#fff' }}>Selected — will mark complete directly</Text>
              </View>
            )}
          </TouchableOpacity>

          {/* CTA */}
          {noCostSelected ? (
            <TouchableOpacity onPress={handleNoCostSubmit} disabled={submitting}
              style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8, backgroundColor:'#22C55E', borderRadius:14, padding:14, opacity:submitting?0.6:1 }}>
              {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
              <Text style={{ fontSize:15, fontWeight:'800', color:'#fff' }}>Mark Complete — No Cost</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => { if (!selectedTier) { Alert.alert('Select a tier first'); return; } setStage('parts_approval'); }}
              style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8, backgroundColor:selectedTier?.accentColor||BRAND, borderRadius:14, padding:14 }}>
              <Ionicons name="cube-outline" size={18} color="#fff" />
              <Text style={{ fontSize:15, fontWeight:'800', color:'#fff' }} >
                Review Parts & Submit — ₹{parts.reduce((s,p) => s+p.quantity*p.unit_price,0).toLocaleString('en-IN')}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setStage('result')}
            style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6, borderWidth:1.5, borderColor:colors.border, borderRadius:14, padding:12 }}>
            <Ionicons name="chevron-back-outline" size={15} color={colors.textSecondary} />
            <Text style={{ fontSize:13, fontWeight:'700', color:colors.textSecondary }}>Back to Diagnosis</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          Stage 6 – PARTS APPROVAL  (editable parts list + submit)
      ════════════════════════════════════════════════════════════════════ */}
      {stage==='parts_approval' && confirmedDiag && selectedTier && (
        <View style={{ gap:14 }}>

          {/* Tier + diagnosis summary */}
          <View style={{ backgroundColor:selectedTier.accentBg, borderRadius:16, padding:14, borderWidth:1.5, borderColor:selectedTier.accentBorder }}>
            <View style={{ flexDirection:'row', alignItems:'center', gap:8, marginBottom:10 }}>
              <Ionicons name={selectedTier.icon as any} size={16} color={selectedTier.accentColor} />
              <Text style={{ fontSize:13, fontWeight:'800', color:selectedTier.accentColor }}>{selectedTier.label} Plan Selected</Text>
              {selectedTier.badge && (
                <View style={{ backgroundColor:selectedTier.accentColor, borderRadius:999, paddingHorizontal:7, paddingVertical:2 }}>
                  <Text style={{ fontSize:8, fontWeight:'800', color:'#fff' }}>{selectedTier.badge}</Text>
                </View>
              )}
            </View>
            <Text style={{ fontSize:10, color:colors.textTertiary, marginBottom:2 }}>PROBLEM</Text>
            <Text style={{ fontSize:13, fontWeight:'700', color:colors.text, marginBottom:8 }}>{confirmedDiag.cause}</Text>
            <Text style={{ fontSize:10, color:colors.textTertiary, marginBottom:2 }}>SOLUTION</Text>
            <Text style={{ fontSize:12, color:colors.text, lineHeight:18 }}>{confirmedDiag.recommendation}</Text>
          </View>

          {/* Editable parts list */}
          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:16, borderWidth:1, borderColor:colors.border }}>
            <View style={{ flexDirection:'row', alignItems:'center', gap:8, marginBottom:4 }}>
              <Ionicons name="cube-outline" size={18} color={BRAND} />
              <Text style={{ fontSize:13, fontWeight:'800', color:colors.text }}>Parts & Cost Details</Text>
            </View>
            <Text style={{ fontSize:12, color:colors.textTertiary, marginBottom:12 }}>
              Review, edit amounts, or add custom parts below.
            </Text>

            {parts.map((part,i) => (
              <View key={i} style={{ backgroundColor:colors.background||colors.surface, borderRadius:12, padding:12, borderWidth:1, borderColor:colors.border, marginBottom:10 }}>
                <View style={{ flexDirection:'row', justifyContent:'space-between', marginBottom:8 }}>
                  <View style={{ flexDirection:'row', alignItems:'center', gap:6 }}>
                    <View style={{ width:7,height:7,borderRadius:3.5, backgroundColor:part.cost_type==='labor'?'#7C3AED':BRAND }} />
                    <Text style={{ fontSize:11, fontWeight:'700', color:colors.textSecondary }}>ITEM {i+1}</Text>
                  </View>
                  <TouchableOpacity onPress={() => removePart(i)}>
                    <Ionicons name="trash-outline" size={16} color="#DC2626" />
                  </TouchableOpacity>
                </View>
                <View style={{ gap:8 }}>
                  <View style={{ gap:4 }}>
                    <Text style={{ fontSize:10, color:colors.textTertiary, fontWeight:'700' }}>PART / SERVICE NAME *</Text>
                    <TextInput value={part.item_name} onChangeText={v => updatePart(i,'item_name',v)}
                      placeholder="e.g. PVC Pipe 1/2 inch" placeholderTextColor={colors.textTertiary}
                      style={{ backgroundColor:colors.surface, borderWidth:1, borderColor:colors.border, borderRadius:10, padding:10, fontSize:13, color:colors.text }} />
                  </View>
                  <View style={{ flexDirection:'row', gap:10 }}>
                    <View style={{ flex:1, gap:4 }}>
                      <Text style={{ fontSize:10, color:colors.textTertiary, fontWeight:'700' }}>QTY</Text>
                      <TextInput value={String(part.quantity)} onChangeText={v => updatePart(i,'quantity',parseInt(v)||1)} keyboardType="numeric"
                        style={{ backgroundColor:colors.surface, borderWidth:1, borderColor:colors.border, borderRadius:10, padding:10, fontSize:13, color:colors.text }} />
                    </View>
                    <View style={{ flex:1, gap:4 }}>
                      <Text style={{ fontSize:10, color:colors.textTertiary, fontWeight:'700' }}>UNIT PRICE (₹)</Text>
                      <TextInput value={String(part.unit_price)} onChangeText={v => updatePart(i,'unit_price',parseFloat(v)||0)} keyboardType="decimal-pad"
                        style={{ backgroundColor:colors.surface, borderWidth:1, borderColor:colors.border, borderRadius:10, padding:10, fontSize:13, color:colors.text }} />
                    </View>
                  </View>
                  <View style={{ flexDirection:'row', gap:8 }}>
                    {(['parts','labor'] as const).map(ct => (
                      <TouchableOpacity key={ct} onPress={() => updatePart(i,'cost_type',ct)}
                        style={{ paddingHorizontal:12, paddingVertical:6, borderRadius:999, backgroundColor:part.cost_type===ct?BRAND_LIGHT:colors.surface, borderWidth:1.5, borderColor:part.cost_type===ct?BRAND:colors.border }}>
                        <Text style={{ fontSize:11, fontWeight:'700', color:part.cost_type===ct?BRAND:colors.textSecondary }}>
                          {ct.charAt(0).toUpperCase()+ct.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={{ fontSize:12, fontWeight:'700', color:BRAND, textAlign:'right' }}>
                    Subtotal: ₹{(part.quantity*part.unit_price).toLocaleString('en-IN')}
                  </Text>
                </View>
              </View>
            ))}

            {/* Add custom part */}
            <TouchableOpacity onPress={addPart}
              style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8, padding:12, borderRadius:12, borderWidth:1.5, borderColor:BRAND, borderStyle:'dashed' }}>
              <Ionicons name="add-circle-outline" size={16} color={BRAND} />
              <Text style={{ fontSize:13, fontWeight:'700', color:BRAND }}>Add Custom Part / Service</Text>
            </TouchableOpacity>

            {/* Total row */}
            {validParts.length>0 && (
              <View style={{ flexDirection:'row', justifyContent:'space-between', backgroundColor:BRAND_LIGHT, borderRadius:12, padding:14, marginTop:12 }}>
                <View>
                  <Text style={{ fontSize:12, color:colors.textTertiary }}>TOTAL ESTIMATE</Text>
                  <Text style={{ fontSize:13, fontWeight:'700', color:colors.text }}>{validParts.length} item{validParts.length!==1?'s':''}</Text>
                </View>
                <Text style={{ fontSize:22, fontWeight:'800', color:BRAND }}>₹{totalCost.toLocaleString('en-IN')}</Text>
              </View>
            )}

            {/* Approver notice */}
            <View style={{ flexDirection:'row', alignItems:'center', gap:8, backgroundColor:'rgba(124,58,237,0.06)', borderRadius:10, padding:10, marginTop:12, borderWidth:1, borderColor:'rgba(124,58,237,0.2)' }}>
              <Ionicons name="person-circle-outline" size={16} color="#7C3AED" />
              <Text style={{ fontSize:11, color:'#7C3AED', flex:1 }}>
                Request will be sent to <Text style={{ fontWeight:'800' }}>{approverName || 'the approver'}</Text> for approval
              </Text>
            </View>

            <View style={{ height:1, backgroundColor:colors.border, marginVertical:14 }} />

            <View style={{ gap:10 }}>
              <TouchableOpacity onPress={handleFinalSubmit} disabled={submitting||validParts.length===0}
                style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8, backgroundColor:'#7C3AED', borderRadius:14, padding:14, opacity:(submitting||validParts.length===0)?0.55:1 }}>
                {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send-outline" size={18} color="#fff" />}
                <Text style={{ fontSize:15, fontWeight:'800', color:'#fff' }}>{submitting?'Submitting…':'Submit Cost Estimate'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStage('cost_options')}
                style={{ flexDirection:'row',alignItems:'center',justifyContent:'center',gap:6, borderWidth:1.5, borderColor:colors.border, borderRadius:14, padding:12 }}>
                <Ionicons name="chevron-back-outline" size={15} color={colors.textSecondary} />
                <Text style={{ fontSize:13, fontWeight:'700', color:colors.textSecondary }}>Back to Cost Options</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Cancel only in early stages */}
      {!['result','cost_options','parts_approval'].includes(stage) && (
        <TouchableOpacity onPress={onCancel} style={{ alignItems:'center', paddingVertical:4 }}>
          <Text style={{ fontSize:13, color:colors.textTertiary, fontWeight:'600' }}>Cancel</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}
// Supabase Edge Function: ask_assistant
// AI assistant for the mobile Floating AI + ticket insights. Holds the LLM API key
// (GROQ_API_KEY, or ANTHROPIC_API_KEY if set) server-side. Port of convex aiAssistant.askAssistant.
// Builds an org-wide live-data snapshot from the get_universal_metrics_v2 RPC + table counts.
//
// Deploy:  supabase functions deploy ask_assistant --no-verify-jwt
// Secrets: supabase secrets set GROQ_API_KEY=...   (and/or ANTHROPIC_API_KEY=...)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function inr(n: number): string {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
}
function normStatus(raw: string | null | undefined): string {
  const s = String(raw || '').toLowerCase().replace(/_/g, '-');
  if (s === 'staying') return 'Staying';
  if (s === 'on-notice') return 'On-Notice';
  if (s === 'booked') return 'Booked';
  if (s === 'exited') return 'Exited';
  return 'New';
}

async function buildSnapshot(sb: any): Promise<string | null> {
  try {
    let acct: any = {}, occ: any = {}, tk: any = {};
    try {
      const { data } = await sb.rpc('get_universal_metrics_v2', { p_organization_id: ORG_ID, p_period: 'current_fy' });
      const payload = Array.isArray(data) ? data[0] : data;
      acct = payload?.accounting || {}; occ = payload?.propertyStatus || {}; tk = payload?.tickets || {};
    } catch (_e) { /* degrade */ }
    const [{ data: tenants }, { data: properties }] = await Promise.all([
      sb.from('tenants').select('staying_status').eq('organization_id', ORG_ID),
      sb.from('properties').select('property_name,name,code,status').eq('organization_id', ORG_ID),
    ]);
    const tList = tenants || []; const pList = properties || [];
    const bucket: Record<string, number> = { New: 0, Booked: 0, Staying: 0, 'On-Notice': 0, Exited: 0 };
    for (const t of tList) { const s = normStatus(t.staying_status); bucket[s] = (bucket[s] || 0) + 1; }
    const liveProps = pList.filter((p: any) => !p.status || ['live', 'Live'].includes(String(p.status)));
    const propNames = pList.map((p: any) => p.property_name || p.name || p.code || 'Unnamed');
    return [
      `LIVE DATA SNAPSHOT — organization-wide. Money figures are current financial year (FY). Occupancy/tenant counts are as of now. All amounts in INR.`,
      ``,
      `TENANTS: ${tList.length} total — ${bucket.Staying} Staying, ${bucket['On-Notice']} On-Notice, ${bucket.Booked} Booked, ${bucket.New} New, ${bucket.Exited} Exited.`,
      `OCCUPANCY: ${occ.total ?? 0} live beds — ${occ.occupied ?? 0} occupied, ${occ.notice ?? 0} on-notice, ${occ.booked ?? 0} booked, ${occ.vacant ?? 0} vacant. Occupancy rate ${occ.occupancyPct ?? 0}%.`,
      `PROPERTIES: ${pList.length} total (${liveProps.length} live)${propNames.length ? ` — ${propNames.join(', ')}` : ''}.`,
      `TICKETS: ${tk.total ?? 0} this FY — ${tk.open ?? 0} open, ${tk.closed ?? 0} closed, ${tk.needsTenantApproval ?? 0} awaiting tenant approval.`,
      `FINANCIALS (current FY): Total invoiced ${inr(acct.totalRevenue ?? acct.totalInvoiced)}, Rental revenue ${inr(acct.totalRentalRevenue)}, EB charged ${inr(acct.totalEbCharged)}, Collections ${inr(acct.totalCollections)}, Pending collection ${inr(acct.totalPendingCollection)}, Deposits collected ${inr(acct.depositCollections)}, Refunds given ${inr(acct.totalRefundsGiven)}, Expenses ${inr(acct.totalExpenses)}, Profit ${inr(acct.totalProfit)}.`,
    ].join('\n');
  } catch (e: any) {
    console.warn('[ask_assistant] snapshot failed:', e?.message);
    return null;
  }
}

function buildSystemPrompt(snapshot: string | null): string {
  const base = `You are the AI assistant inside "Vishful Spaces", a property-management app for co-living / PG operators (properties, apartments, beds, tenants, maintenance tickets, accounting, and team management).

Help staff with how-to guidance, explanations, drafting (announcements, messages, summaries), and answering questions about their organization's live data using the snapshot below.

Answer concisely and practically. When you cite a number, use the snapshot values verbatim (you may reformat currency, e.g. lakhs/crores). Do not include any internal or system XML tags in your response.`;
  if (!snapshot) {
    return `${base}\n\nNote: the live-data snapshot is temporarily unavailable this turn. If asked for specific figures, say the data couldn't be loaded right now and point the user to the relevant screen (Tenants, Reports, Tickets, Accounting).`;
  }
  return `${base}\n\nUse the following snapshot as your source of truth for live figures. It is AGGREGATE data only — it does not contain per-record lists. If asked for record-level detail the snapshot can't answer, give what the snapshot supports and point the user to the relevant screen (Tenants, Reports, Tickets, Accounting, EB). Never invent figures that aren't in the snapshot.\n\n${snapshot}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { question, history } = await req.json();
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    const groqKey = Deno.env.get('GROQ_API_KEY');
    if (!anthropicKey && !groqKey) {
      return json({ answer: "The AI assistant isn't configured yet — set GROQ_API_KEY (or ANTHROPIC_API_KEY) as an edge function secret." });
    }
    const msgs = (history || [])
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: question });

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const SYSTEM_PROMPT = buildSystemPrompt(await buildSnapshot(sb));

    if (anthropicKey) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1024, system: SYSTEM_PROMPT, messages: msgs }),
      });
      if (!resp.ok) return json({ answer: `Sorry — the AI service returned an error (${resp.status}). Please try again.` });
      const data: any = await resp.json();
      const answer = Array.isArray(data?.content) ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim() : '';
      return json({ answer: answer || 'No response.' });
    }
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', max_tokens: 1024, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...msgs] }),
    });
    if (!resp.ok) return json({ answer: `Sorry — the AI service returned an error (${resp.status}). Please try again.` });
    const data: any = await resp.json();
    return json({ answer: (data?.choices?.[0]?.message?.content || '').trim() || 'No response.' });
  } catch (e: any) {
    console.error('[ask_assistant] error:', e?.message);
    return json({ answer: "Sorry — I couldn't reach the AI service. Please try again." });
  }
});

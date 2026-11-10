// Supabase Edge Function: send_otp
// Server-side OTP sender — holds the service-role key and the Fast2SMS key,
// which must NEVER ship in the mobile app. Faithful port of the Convex
// action otpAuth.sendOtp.
//
// Deploy:   supabase functions deploy send_otp --no-verify-jwt
// Secrets:  supabase secrets set FAST2SMS_API_KEY=... SMS_ENABLED=true
//           (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function generateOtp(phone: string): string {
  if (phone === '9876543210') return '123456'; // demo viewer account
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isSmsEnabled(): boolean {
  return (Deno.env.get('SMS_ENABLED') || 'false').toLowerCase() === 'true';
}

async function sendSmsOtp(phone: string, otp: string): Promise<void> {
  const apiKey = Deno.env.get('FAST2SMS_API_KEY');
  if (!apiKey) {
    console.warn('[SMS] FAST2SMS_API_KEY not set — skipping SMS');
    return;
  }
  const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: { authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      route: 'dlt',
      sender_id: 'VISHFL',
      message: '163996',
      variables_values: otp,
      flash: 0,
      numbers: phone,
    }),
  });
  const raw = await response.text();
  console.log('[SMS] HTTP status:', response.status, '| response:', raw);
  let result: any = {};
  try { result = JSON.parse(raw); } catch { result = { return: response.status === 200, message: [raw] }; }
  if (!result.return) throw new Error(`Fast2SMS error: ${JSON.stringify(result.message)}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { phone } = await req.json();
    if (!phone || typeof phone !== 'string') return json({ success: false, message: 'Phone number required.' });

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = cleanPhone.slice(2);
    else if (cleanPhone.length === 11 && cleanPhone.startsWith('0')) cleanPhone = cleanPhone.slice(1);
    cleanPhone = cleanPhone.slice(-10);
    const phoneVariants = [cleanPhone, `+91${cleanPhone}`, `91${cleanPhone}`];

    let foundTeamMember: any = null;
    for (const variant of phoneVariants) {
      const { data } = await sb.from('team_members').select('id, status').eq('phone', variant).maybeSingle();
      if (data) { foundTeamMember = data; break; }
    }
    let foundTenant: any = null;
    for (const variant of phoneVariants) {
      const { data } = await sb.from('tenants').select('id, full_name, staying_status, phone').eq('phone', variant).maybeSingle();
      if (data) { foundTenant = data; break; }
    }

    if (!foundTeamMember && !foundTenant)
      return json({ success: false, message: 'User not found. Please contact your administrator.' });
    if (foundTeamMember && foundTeamMember.status !== 'active')
      return json({ success: false, message: `Access denied. Your team account is currently "${foundTeamMember.status}". Contact your administrator.` });
    if (!foundTeamMember && foundTenant) {
      const tenantStatus = (foundTenant.staying_status || '').toLowerCase();
      if (tenantStatus === 'new')
        return json({ success: false, message: 'Your status is "New". You will be able to log in once onboarding is completed.' });
      const allowed = ['staying', 'on-notice', 'booked'];
      if (!allowed.includes(tenantStatus))
        return json({ success: false, message: `Access denied. Your tenant status is "${foundTenant.staying_status || 'unknown'}". Only active tenants can log in.` });
    }

    const generatedOtp = generateOtp(cleanPhone);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await sb.from('otp_codes').delete().eq('phone', cleanPhone);
    const { error: insertError } = await sb.from('otp_codes').insert({ phone: cleanPhone, otp_code: generatedOtp, expires_at: expiresAt });
    if (insertError) {
      console.error('[OTP] Failed to store OTP:', insertError);
      return json({ success: false, message: 'Failed to generate OTP. Please try again.' });
    }

    if (isSmsEnabled()) {
      try {
        await sendSmsOtp(cleanPhone, generatedOtp);
        console.log(`[OTP] SMS sent to ${cleanPhone}`);
      } catch (smsErr: any) {
        console.error('[OTP] SMS send failed:', smsErr?.message);
        return json({ success: false, message: 'Failed to send OTP SMS. Please try again.' });
      }
    } else {
      console.log(`[OTP] 🔕 SMS MUTED (dev mode) | phone: ${cleanPhone} | OTP: ${generatedOtp}`);
    }

    return json({ success: true, message: 'OTP sent successfully' });
  } catch (err: any) {
    console.error('[send_otp] Error:', err?.message);
    return json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

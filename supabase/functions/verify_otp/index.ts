// Supabase Edge Function: verify_otp
// Server-side OTP verification + session minting. Holds the service-role key
// (creates/updates Supabase Auth users), which must NEVER ship in the app.
// Faithful port of the Convex action otpAuth.verifyOtpAndLogin (+ ensureTenantRole).
//
// Deploy: supabase functions deploy verify_otp --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function ensureTenantRole(sb: any, userId: string, tenant: any) {
  try {
    const { data: existingRole } = await sb.from('user_roles').select('id').eq('user_id', userId).eq('role', 'tenant').maybeSingle();
    if (!existingRole) await sb.from('user_roles').insert({ user_id: userId, role: 'tenant' });
    if (tenant?.id) {
      const { data: currentTenant } = await sb.from('tenants').select('user_id').eq('id', tenant.id).maybeSingle();
      if (currentTenant && !currentTenant.user_id) await sb.from('tenants').update({ user_id: userId }).eq('id', tenant.id);
    }
    if (tenant?.organization_id) {
      await sb.from('profiles').update({ organization_id: tenant.organization_id, full_name: tenant.full_name, phone: tenant.phone }).eq('id', userId);
    }
  } catch (err: any) {
    console.error('[ensureTenantRole] Error:', err?.message);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { phone, otp } = await req.json();
    const URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

    let cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = cleanPhone.slice(2);
    else if (cleanPhone.length === 11 && cleanPhone.startsWith('0')) cleanPhone = cleanPhone.slice(1);
    cleanPhone = cleanPhone.slice(-10);
    const phoneVariants = [cleanPhone, `+91${cleanPhone}`, `91${cleanPhone}`];

    if (!otp || String(otp).length !== 6) return json({ success: false, message: 'Please enter a valid 6-digit OTP.' });

    const { data: otpRecord } = await sb
      .from('otp_codes').select('*')
      .eq('phone', cleanPhone).eq('otp_code', otp).eq('verified', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!otpRecord) return json({ success: false, message: 'Invalid or expired OTP. Please request a new one.' });

    await sb.from('otp_codes').update({ verified: true }).eq('id', otpRecord.id);

    const email = `${cleanPhone}@vishful.local`;
    const password = `vishful_otp_${cleanPhone}_${Date.now()}_secure`;

    let foundTeamMember: any = null;
    for (const variant of phoneVariants) {
      const { data } = await sb.from('team_members').select('id, first_name, last_name, status, user_id').eq('phone', variant).maybeSingle();
      if (data) { foundTeamMember = data; break; }
    }
    let foundTenant: any = null;
    for (const variant of phoneVariants) {
      const { data } = await sb.from('tenants').select('id, full_name, staying_status, phone, organization_id').eq('phone', variant).maybeSingle();
      if (data) { foundTenant = data; break; }
    }

    let userType = 'unknown';
    if (foundTeamMember) {
      userType = 'team_member';
      if (foundTeamMember.status !== 'active') return json({ success: false, message: `Access denied. Your team account is currently "${foundTeamMember.status}".` });
    } else if (foundTenant) {
      userType = 'tenant';
      const tenantStatus = (foundTenant.staying_status || '').toLowerCase();
      if (tenantStatus === 'new') return json({ success: false, message: 'Your status is "New". You will be able to log in once onboarding is completed.' });
      const allowed = ['staying', 'on-notice', 'booked'];
      if (!allowed.includes(tenantStatus)) return json({ success: false, message: `Access denied. Your tenant status is "${foundTenant.staying_status || 'unknown'}".` });
    }

    const signInClient = createClient(URL, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: existingUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const found = existingUsers?.users?.find((u: any) => u.email === email) ?? null;

    let sessionData: any = null;
    if (found) {
      await sb.auth.admin.updateUserById(found.id, { password });
      const { data: signInData, error: signInError } = await signInClient.auth.signInWithPassword({ email, password });
      if (signInError) return json({ success: false, message: signInError.message });
      sessionData = signInData;
      if (userType === 'tenant' && found.id) await ensureTenantRole(sb, found.id, foundTenant);
    } else {
      const fullName = foundTeamMember
        ? `${foundTeamMember.first_name || ''} ${foundTeamMember.last_name || ''}`.trim()
        : foundTenant?.full_name || '';
      const { data: newUser, error: createError } = await sb.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { phone: cleanPhone, full_name: fullName },
      });
      if (createError) {
        if (createError.message?.toLowerCase().includes('already')) {
          const { data: allUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
          const existingUser = allUsers?.users?.find((u: any) => u.email === email);
          if (existingUser) {
            await sb.auth.admin.updateUserById(existingUser.id, { password });
            const { data: fb, error: fbErr } = await signInClient.auth.signInWithPassword({ email, password });
            if (fbErr) return json({ success: false, message: fbErr.message });
            sessionData = fb;
            if (userType === 'tenant' && existingUser.id) await ensureTenantRole(sb, existingUser.id, foundTenant);
          } else {
            return json({ success: false, message: createError.message });
          }
        } else {
          return json({ success: false, message: createError.message });
        }
      } else {
        const { data: newSession, error: newErr } = await signInClient.auth.signInWithPassword({ email, password });
        if (newErr) return json({ success: false, message: newErr.message });
        sessionData = newSession;
        if (userType === 'tenant' && newUser?.user?.id) await ensureTenantRole(sb, newUser.user.id, foundTenant);
      }
    }

    await sb.from('otp_codes').delete().eq('phone', cleanPhone);

    const authUserId = sessionData?.user?.id;
    let resolvedRole = userType;
    if (userType === 'team_member') {
      if (foundTeamMember?.user_id) {
        const { data: roleData } = await sb.from('user_roles').select('role').eq('user_id', foundTeamMember.user_id).maybeSingle();
        if (roleData?.role) resolvedRole = roleData.role;
      }
      if (resolvedRole === userType && authUserId) {
        const { data: roleData } = await sb.from('user_roles').select('role').eq('user_id', authUserId).maybeSingle();
        if (roleData?.role) resolvedRole = roleData.role;
      }
    } else if (userType === 'tenant') {
      resolvedRole = 'tenant';
    }

    const userName = foundTeamMember
      ? `${foundTeamMember.first_name || ''} ${foundTeamMember.last_name || ''}`.trim()
      : foundTenant?.full_name || '';

    return json({
      success: true,
      token: sessionData?.session?.access_token || '',
      refreshToken: sessionData?.session?.refresh_token || '',
      user_type: userType,
      user: {
        userId: authUserId || '',
        userName,
        phone: cleanPhone,
        role: resolvedRole,
        organizationId: foundTenant?.organization_id || '',
        organizationName: 'Vishful Spaces LLP',
        supabaseUserId: authUserId || null,
      },
    });
  } catch (err: any) {
    console.error('[verify_otp] Error:', err?.message);
    return json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

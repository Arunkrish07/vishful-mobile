"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { createClient } from "@supabase/supabase-js";
import { getSupabase } from "./lib/supabaseAdmin";

function generateOtp(phone: string): string {
  // Demo OTP for viewer account testing
  if (phone === "9876543210") {
    return "123456";
  }
  // Random OTP for all other numbers
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ─── SMS CONFIG ──────────────────────────────────────────────────────
// SMS_ENABLED  = "true"  → send real SMS via Fast2SMS
// SMS_ENABLED  = "false" → mute SMS, OTP only printed in Convex logs (dev mode)
// Set these in your Convex dashboard → Settings → Environment Variables
function isSmsEnabled(): boolean {
  return (process.env.SMS_ENABLED || "false").toLowerCase() === "true";
}

async function sendSmsOtp(phone: string, otp: string): Promise<void> {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    console.warn("[SMS] FAST2SMS_API_KEY not set — skipping SMS");
    return;
  }

  // Fast2SMS DLT route via POST JSON
  // message = numeric Fast2SMS message ID (163996), NOT the text
  // variables_values = the OTP value injected into {#var#}
  console.log("[SMS] Sending DLT SMS to", phone);

  const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      "authorization": apiKey,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      route:            "dlt",
      sender_id:        "VISHFL",
      message:          "163996",
      variables_values: otp,
      flash:            0,
      numbers:          phone,
    }),
  });

  const raw = await response.text();
  console.log("[SMS] HTTP status:", response.status, "| response:", raw);

  let result: any = {};
  try { result = JSON.parse(raw); } catch { result = { return: response.status === 200, message: [raw] }; }

  if (!result.return) {
    console.error("[SMS] Fast2SMS failed:", raw);
    throw new Error(`Fast2SMS error: ${JSON.stringify(result.message)}`);
  }

  console.log("[SMS] Sent successfully to", phone, "| requestId:", result.request_id);
}

// ─── SEND OTP (matches Edge Function send_otp) ──────────────────────
export const sendOtp = action({
  args: { phone: v.string() },
  returns: v.any(),
  handler: async (_ctx, { phone }) => {
    try {
      const sb = getSupabase();
      let cleanPhone = phone.replace(/[^0-9]/g, "");
      // strip country code / leading zero ONLY when it makes a 10-digit number
      if (cleanPhone.length === 12 && cleanPhone.startsWith("91")) cleanPhone = cleanPhone.slice(2);
      else if (cleanPhone.length === 11 && cleanPhone.startsWith("0")) cleanPhone = cleanPhone.slice(1);
      cleanPhone = cleanPhone.slice(-10);
      const phoneVariants = [cleanPhone, `+91${cleanPhone}`, `91${cleanPhone}`];

      // Find team member
      let foundTeamMember: any = null;
      for (const variant of phoneVariants) {
        const { data } = await sb.from("team_members").select("id, status").eq("phone", variant).maybeSingle();
        if (data) { foundTeamMember = data; break; }
      }

      // Find tenant
      let foundTenant: any = null;
      for (const variant of phoneVariants) {
        const { data } = await sb.from("tenants").select("id, full_name, staying_status, phone").eq("phone", variant).maybeSingle();
        if (data) { foundTenant = data; break; }
      }

      if (!foundTeamMember && !foundTenant) {
        return { success: false, message: "User not found. Please contact your administrator." };
      }

      if (foundTeamMember && foundTeamMember.status !== "active") {
        return { success: false, message: `Access denied. Your team account is currently "${foundTeamMember.status}". Contact your administrator.` };
      }

      if (!foundTeamMember && foundTenant) {
        const tenantStatus = (foundTenant.staying_status || "").toLowerCase();
        if (tenantStatus === "new") {
          return { success: false, message: 'Your status is "New". You will be able to log in once onboarding is completed.' };
        }
        const allowedStatuses = ["staying", "on-notice", "booked"];
        if (!allowedStatuses.includes(tenantStatus)) {
          return { success: false, message: `Access denied. Your tenant status is "${foundTenant.staying_status || "unknown"}". Only active tenants can log in.` };
        }
      }

      const generatedOtp = generateOtp(cleanPhone);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await sb.from("otp_codes").delete().eq("phone", cleanPhone);

      const { error: insertError } = await sb.from("otp_codes").insert({
        phone: cleanPhone,
        otp_code: generatedOtp,
        expires_at: expiresAt,
      });

      if (insertError) {
        console.error("[OTP] Failed to store OTP:", insertError);
        return { success: false, message: "Failed to generate OTP. Please try again." };
      }

      if (isSmsEnabled()) {
        // ── PRODUCTION: send real SMS via Fast2SMS ──────────────────
        try {
          await sendSmsOtp(cleanPhone, generatedOtp);
          console.log(`[OTP] SMS sent to ${cleanPhone}`);
        } catch (smsErr: any) {
          console.error("[OTP] SMS send failed:", smsErr?.message);
          // Still return success — OTP is stored, user can retry or check logs
          return { success: false, message: "Failed to send OTP SMS. Please try again." };
        }
      } else {
        // ── DEV MODE: SMS muted — OTP visible in Convex logs only ───
        console.log(`[OTP] 🔕 SMS MUTED (dev mode) | phone: ${cleanPhone} | OTP: ${generatedOtp}`);
      }

      return { success: true, message: "OTP sent successfully" };
    } catch (err: any) {
      console.error("[sendOtp] Error:", err?.message);
      return { success: false, message: "Something went wrong. Please try again." };
    }
  },
});

// ─── VERIFY OTP + LOGIN (matches Edge Function verify_otp) ──────────
export const verifyOtpAndLogin = action({
  args: { phone: v.string(), otp: v.string() },
  returns: v.any(),
  handler: async (_ctx, { phone, otp }) => {
    try {
      const sb = getSupabase();
      let cleanPhone = phone.replace(/[^0-9]/g, "");
      // strip country code / leading zero ONLY when it makes a 10-digit number
      if (cleanPhone.length === 12 && cleanPhone.startsWith("91")) cleanPhone = cleanPhone.slice(2);
      else if (cleanPhone.length === 11 && cleanPhone.startsWith("0")) cleanPhone = cleanPhone.slice(1);
      cleanPhone = cleanPhone.slice(-10);
      const phoneVariants = [cleanPhone, `+91${cleanPhone}`, `91${cleanPhone}`];

      if (!otp || otp.length !== 6) {
        return { success: false, message: "Please enter a valid 6-digit OTP." };
      }

      // 1. Validate OTP (exact Edge Function query)
      const { data: otpRecord } = await sb
        .from("otp_codes")
        .select("*")
        .eq("phone", cleanPhone)
        .eq("otp_code", otp)
        .eq("verified", false)
        .gte("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!otpRecord) {
        return { success: false, message: "Invalid or expired OTP. Please request a new one." };
      }

      // Mark OTP as verified
      await sb.from("otp_codes").update({ verified: true }).eq("id", otpRecord.id);

      // 2. Build email/password (exact Edge Function pattern)
      const email = `${cleanPhone}@vishful.local`;
      const password = `vishful_otp_${cleanPhone}_${Date.now()}_secure`;

      // 3. Find team member
      let foundTeamMember: any = null;
      for (const variant of phoneVariants) {
        const { data } = await sb
          .from("team_members")
          .select("id, first_name, last_name, status, user_id")
          .eq("phone", variant)
          .maybeSingle();
        if (data) { foundTeamMember = data; break; }
      }

      // 4. Find tenant
      let foundTenant: any = null;
      for (const variant of phoneVariants) {
        const { data } = await sb
          .from("tenants")
          .select("id, full_name, staying_status, phone, organization_id")
          .eq("phone", variant)
          .maybeSingle();
        if (data) { foundTenant = data; break; }
      }

      // 5. Determine userType and validate status (exact Edge Function logic)
      let userType = "unknown";

      if (foundTeamMember) {
        userType = "team_member";
        if (foundTeamMember.status !== "active") {
          return {
            success: false,
            message: `Access denied. Your team account is currently "${foundTeamMember.status}".`,
          };
        }
      } else if (foundTenant) {
        userType = "tenant";
        const tenantStatus = (foundTenant.staying_status || "").toLowerCase();
        if (tenantStatus === "new") {
          return {
            success: false,
            message: 'Your status is "New". You will be able to log in once onboarding is completed.',
          };
        }
        const allowedStatuses = ["staying", "on-notice", "booked"];
        if (!allowedStatuses.includes(tenantStatus)) {
          return {
            success: false,
            message: `Access denied. Your tenant status is "${foundTenant.staying_status || "unknown"}".`,
          };
        }
      }

      // 6. Supabase Auth — create sign-in client (exact Edge Function pattern)
      const signInClient = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );

      // Check if user exists in Supabase Auth by email
      const { data: existingUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
      const found = existingUsers?.users?.find((u: any) => u.email === email) ?? null;

      let sessionData: any = null;

      if (found) {
        // Existing user — update password and sign in
        await sb.auth.admin.updateUserById(found.id, { password });
        const { data: signInData, error: signInError } = await signInClient.auth.signInWithPassword({ email, password });
        if (signInError) {
          console.error("[verifyOtp] signIn error:", signInError.message);
          return { success: false, message: signInError.message };
        }
        sessionData = signInData;
        if (userType === "tenant" && found.id) {
          await ensureTenantRole(sb, found.id, foundTenant);
        }
      } else {
        // New user — create and sign in
        const fullName = foundTeamMember
          ? `${foundTeamMember.first_name || ""} ${foundTeamMember.last_name || ""}`.trim()
          : foundTenant?.full_name || "";

        const { data: newUser, error: createError } = await sb.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { phone: cleanPhone, full_name: fullName },
        });

        // If user already exists (race condition / listUsers missed them), update password instead
        if (createError) {
          if (createError.message?.toLowerCase().includes("already")) {
            console.warn("[verifyOtp] User already exists, fetching via listUsers fallback");
            const { data: allUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
            const existingUser = allUsers?.users?.find((u: any) => u.email === email);
            if (existingUser) {
              await sb.auth.admin.updateUserById(existingUser.id, { password });
              const { data: fallbackSession, error: fallbackError } = await signInClient.auth.signInWithPassword({ email, password });
              if (fallbackError) {
                console.error("[verifyOtp] fallback signIn error:", fallbackError.message);
                return { success: false, message: fallbackError.message };
              }
              sessionData = fallbackSession;
              if (userType === "tenant" && existingUser.id) {
                await ensureTenantRole(sb, existingUser.id, foundTenant);
              }
            } else {
              console.error("[verifyOtp] createUser error:", createError.message);
              return { success: false, message: createError.message };
            }
          } else {
            console.error("[verifyOtp] createUser error:", createError.message);
            return { success: false, message: createError.message };
          }
        } else {
          const { data: newSession, error: newSignInError } = await signInClient.auth.signInWithPassword({ email, password });
          if (newSignInError) {
            console.error("[verifyOtp] signIn (new) error:", newSignInError.message);
            return { success: false, message: newSignInError.message };
          }
          sessionData = newSession;
          if (userType === "tenant" && newUser?.user?.id) {
            await ensureTenantRole(sb, newUser.user.id, foundTenant);
          }
        }
      }

      // 7. Clean up OTP (exact Edge Function)
      await sb.from("otp_codes").delete().eq("phone", cleanPhone);

      // 8. Resolve role dynamically from user_roles table
      const authUserId = sessionData?.user?.id;
      let resolvedRole = userType; // fallback to userType if no role found

      if (userType === "team_member") {
        // Try team_members.user_id first (the real identity in the system)
        if (foundTeamMember?.user_id) {
          const { data: roleData } = await sb
            .from("user_roles")
            .select("role")
            .eq("user_id", foundTeamMember.user_id)
            .maybeSingle();
          if (roleData?.role) resolvedRole = roleData.role;
        }
        // Fallback: try Supabase Auth user ID
        if (resolvedRole === userType && authUserId) {
          const { data: roleData } = await sb
            .from("user_roles")
            .select("role")
            .eq("user_id", authUserId)
            .maybeSingle();
          if (roleData?.role) resolvedRole = roleData.role;
        }
      } else if (userType === "tenant") {
        resolvedRole = "tenant";
      }

      // Build user info
      const userName = foundTeamMember
        ? `${foundTeamMember.first_name || ""} ${foundTeamMember.last_name || ""}`.trim()
        : foundTenant?.full_name || "";

      console.log(`[verifyOtp] success: userType=${userType}, role=${resolvedRole}, authUserId=${authUserId}`);

      // Return in format compatible with frontend auth context
      return {
        success: true,
        token: sessionData?.session?.access_token || "",
        user_type: userType,
        user: {
          userId: authUserId || "",
          userName,
          phone: cleanPhone,
          role: resolvedRole,
          organizationId: foundTenant?.organization_id || "",
          organizationName: "Vishful Spaces LLP",
          supabaseUserId: authUserId || null,
        },
      };
    } catch (err: any) {
      console.error("[verifyOtpAndLogin] Error:", err?.message);
      return { success: false, message: "Something went wrong. Please try again." };
    }
  },
});

// ─── ENSURE TENANT ROLE (exact Edge Function) ────────────────────────
async function ensureTenantRole(sb: any, userId: string, tenant: any) {
  try {
    const { data: existingRole } = await sb
      .from("user_roles")
      .select("id")
      .eq("user_id", userId)
      .eq("role", "tenant")
      .maybeSingle();

    if (!existingRole) {
      await sb.from("user_roles").insert({ user_id: userId, role: "tenant" });
    }

    // ── AUTO-HEALING: Link tenant to auth user ──────────────────────────
    if (tenant?.id) {
      // Check current state
      const { data: currentTenant } = await sb
        .from("tenants")
        .select("user_id")
        .eq("id", tenant.id)
        .maybeSingle();

      // Only update if user_id is null (not already linked)
      if (currentTenant && !currentTenant.user_id) {
        await sb.from("tenants").update({ user_id: userId }).eq("id", tenant.id);
        console.log(`[ensureTenantRole] Auto-healed: tenant ${tenant.id} linked to auth user ${userId}`);
      }
    }

    if (tenant?.organization_id) {
      await sb.from("profiles").update({
        organization_id: tenant.organization_id,
        full_name: tenant.full_name,
        phone: tenant.phone,
      }).eq("id", userId);
    }
  } catch (err: any) {
    console.error("[ensureTenantRole] Error:", err?.message);
  }
}

// ─── GET SESSION (validates Supabase Auth token) ─────────────────────
export const getSession = action({
  args: { token: v.string() },
  returns: v.any(),
  handler: async (_ctx, { token }) => {
    if (!token || typeof token !== "string" || token.trim().length === 0) {
      return { valid: false };
    }

    try {
      const sb = getSupabase();

      // Validate token via Supabase Auth
      const { data: { user }, error } = await sb.auth.getUser(token);
      if (error || !user) {
        return { valid: false };
      }

      // Extract phone from email
      const email = user.email || "";
      const phone = email.replace("@vishful.local", "");
      const phoneVariants = [phone, `+91${phone}`, `91${phone}`];

      let userType = "unknown";
      let resolvedRole = "unknown";
      let userName = "";
      let organizationId = "";

      // Check team_members
      let foundTeamMember: any = null;
      for (const variant of phoneVariants) {
        const { data } = await sb
          .from("team_members")
          .select("id, first_name, last_name, user_id")
          .eq("phone", variant)
          .maybeSingle();
        if (data) { foundTeamMember = data; break; }
      }

      if (foundTeamMember) {
        userType = "team_member";
        userName = `${foundTeamMember.first_name || ""} ${foundTeamMember.last_name || ""}`.trim();

        // Get role from user_roles using team_members.user_id
        if (foundTeamMember.user_id) {
          const { data: roleData } = await sb
            .from("user_roles")
            .select("role")
            .eq("user_id", foundTeamMember.user_id)
            .maybeSingle();
          if (roleData?.role) resolvedRole = roleData.role;
        }
        // Fallback 1: try Supabase Auth user ID
        if (resolvedRole === "unknown" && user.id) {
          const { data: roleData } = await sb
            .from("user_roles")
            .select("role")
            .eq("user_id", user.id)
            .maybeSingle();
          if (roleData?.role) resolvedRole = roleData.role;
        }
        // Fallback 2: try team_member.id directly as user_id in user_roles
        if (resolvedRole === "unknown" && foundTeamMember.id) {
          const { data: roleData } = await sb
            .from("user_roles")
            .select("role")
            .eq("user_id", foundTeamMember.id)
            .maybeSingle();
          if (roleData?.role) resolvedRole = roleData.role;
        }
        // Fallback 3: look up org permissions table if it exists
        if (resolvedRole === "unknown" && foundTeamMember.id) {
          const { data: permData } = await sb
            .from("org_permissions")
            .select("role")
            .eq("team_member_id", foundTeamMember.id)
            .maybeSingle();
          if ((permData as any)?.role) resolvedRole = (permData as any).role;
        }
        if (resolvedRole === "unknown") resolvedRole = userType;
      } else {
        // Check tenants
        for (const variant of phoneVariants) {
          const { data } = await sb
            .from("tenants")
            .select("id, full_name, organization_id")
            .eq("phone", variant)
            .maybeSingle();
          if (data) {
            userType = "tenant";
            resolvedRole = "tenant";
            userName = data.full_name || "";
            organizationId = data.organization_id || "";
            break;
          }
        }
      }

      console.log(`[getSession] valid: phone=${phone}, role=${resolvedRole}, userType=${userType}`);

      return {
        valid: true,
        userId: user.id,
        supabaseUserId: user.id,  // same value login sets; lets the background rebuild preserve it
        userName,
        phone,
        role: resolvedRole,
        organizationId,
        organizationName: "Vishful Spaces LLP",
      };
    } catch (err: any) {
      console.error("[getSession] Error:", err?.message);
      return { valid: false };
    }
  },
});
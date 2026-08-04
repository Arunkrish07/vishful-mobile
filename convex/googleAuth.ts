"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { createClient } from "@supabase/supabase-js";
import { getSupabase } from "./lib/supabaseAdmin";

// Google's tokeninfo returns all fields as strings.
interface GoogleTokenInfo {
  aud?: string;
  email?: string;
  email_verified?: string; // "true" | "false"
  exp?: string;            // unix seconds as string
  iss?: string;
  name?: string;
  sub?: string;
}

async function verifyGoogleIdToken(idToken: string): Promise<
  { ok: true; email: string } | { ok: false; message: string }
> {
  const webClientId = process.env.GOOGLE_WEB_CLIENT_ID;
  if (!webClientId) {
    console.error("[googleAuth] GOOGLE_WEB_CLIENT_ID not set");
    return { ok: false, message: "Google sign-in is not configured. Contact your administrator." };
  }

  let info: GoogleTokenInfo;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
    if (!res.ok) {
      return { ok: false, message: "Google sign-in failed. Please try again." };
    }
    info = (await res.json()) as GoogleTokenInfo;
  } catch (e: any) {
    console.error("[googleAuth] tokeninfo fetch error:", e?.message);
    return { ok: false, message: "Google sign-in failed. Please try again." };
  }

  const validIssuers = ["accounts.google.com", "https://accounts.google.com"];
  if (!info.iss || !validIssuers.includes(info.iss)) {
    return { ok: false, message: "Google sign-in failed. Please try again." };
  }
  if (info.aud !== webClientId) {
    console.warn("[googleAuth] aud mismatch:", info.aud);
    return { ok: false, message: "Google sign-in failed. Please try again." };
  }
  if (info.email_verified !== "true") {
    return { ok: false, message: "Your Google email isn't verified." };
  }
  const expSec = Number(info.exp || 0);
  if (!expSec || expSec * 1000 < Date.now()) {
    return { ok: false, message: "Google sign-in expired. Please try again." };
  }
  if (!info.email) {
    return { ok: false, message: "Google sign-in failed. Please try again." };
  }
  return { ok: true, email: info.email.toLowerCase() };
}

export const verifyGoogleAndLogin = action({
  args: { idToken: v.string() },
  returns: v.any(),
  handler: async (_ctx, { idToken }) => {
    try {
      const verified = await verifyGoogleIdToken(idToken);
      if (!verified.ok) {
        return { success: false, message: verified.message };
      }
      const email = verified.email;

      const sb = getSupabase();

      // 1. Match an ACTIVE team member by email (case-insensitive exact).
      // Cast to any — the Supabase client has no generated schema type (house
      // style; otpAuth does the same), so query rows are otherwise `never`.
      const { data: teamMemberData } = await sb
        .from("team_members")
        .select("id, first_name, last_name, status, user_id, phone")
        .ilike("email", email)
        .maybeSingle();
      const teamMember: any = teamMemberData;

      if (!teamMember) {
        return {
          success: false,
          message: "This Google account isn't linked to a staff member. Contact your administrator.",
        };
      }
      if (teamMember.status !== "active") {
        return {
          success: false,
          message: `Access denied. Your team account is currently "${teamMember.status}".`,
        };
      }
      if (!teamMember.phone) {
        return {
          success: false,
          message: "Your staff record has no phone on file. Contact your administrator.",
        };
      }

      // 2. Sign the member into Supabase under {phone}@vishful.local (mirrors otpAuth).
      const cleanPhone = String(teamMember.phone).replace(/[^0-9]/g, "").slice(-10);
      const supaEmail = `${cleanPhone}@vishful.local`;
      const password = `vishful_google_${cleanPhone}_${Date.now()}_secure`;

      const signInClient = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );

      const { data: existingUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
      const found = existingUsers?.users?.find((u: any) => u.email === supaEmail) ?? null;

      let sessionData: any = null;
      if (found) {
        await sb.auth.admin.updateUserById(found.id, { password });
        const { data: signInData, error: signInError } =
          await signInClient.auth.signInWithPassword({ email: supaEmail, password });
        if (signInError) {
          console.error("[googleAuth] signIn error:", signInError.message);
          return { success: false, message: signInError.message };
        }
        sessionData = signInData;
      } else {
        const fullName = `${teamMember.first_name || ""} ${teamMember.last_name || ""}`.trim();
        const { data: newUser, error: createError } = await sb.auth.admin.createUser({
          email: supaEmail,
          password,
          email_confirm: true,
          user_metadata: { phone: cleanPhone, full_name: fullName },
        });
        if (createError) {
          console.error("[googleAuth] createUser error:", createError.message);
          return { success: false, message: createError.message };
        }
        const { data: newSession, error: newSignInError } =
          await signInClient.auth.signInWithPassword({ email: supaEmail, password });
        if (newSignInError) {
          console.error("[googleAuth] signIn (new) error:", newSignInError.message);
          return { success: false, message: newSignInError.message };
        }
        sessionData = newSession;
        void newUser;
      }

      const authUserId = sessionData?.user?.id;

      // 3. Resolve role from user_roles (mirrors otpAuth: prefer team_members.user_id).
      let resolvedRole = "team_member";
      if (teamMember.user_id) {
        const roleData: any = (await sb
          .from("user_roles")
          .select("role")
          .eq("user_id", teamMember.user_id)
          .maybeSingle()).data;
        if (roleData?.role) resolvedRole = roleData.role;
      }
      if (resolvedRole === "team_member" && authUserId) {
        const roleData: any = (await sb
          .from("user_roles")
          .select("role")
          .eq("user_id", authUserId)
          .maybeSingle()).data;
        if (roleData?.role) resolvedRole = roleData.role;
      }

      const userName = `${teamMember.first_name || ""} ${teamMember.last_name || ""}`.trim();

      console.log(`[googleAuth] success: email=${email}, role=${resolvedRole}, authUserId=${authUserId}`);

      return {
        success: true,
        token: sessionData?.session?.access_token || "",
        user_type: "team_member",
        user: {
          userId: authUserId || "",
          userName,
          phone: cleanPhone,
          role: resolvedRole,
          organizationId: "",
          organizationName: "Vishful Spaces LLP",
          supabaseUserId: authUserId || null,
        },
      };
    } catch (err: any) {
      console.error("[verifyGoogleAndLogin] Error:", err?.message);
      return { success: false, message: "Something went wrong. Please try again." };
    }
  },
});

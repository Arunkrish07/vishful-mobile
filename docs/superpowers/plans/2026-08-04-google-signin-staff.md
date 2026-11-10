# Staff Google Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Continue with Google" as an alternative login for staff (`team_members`), matched by verified email, minting the same Supabase session the OTP flow already uses.

**Architecture:** The client obtains a Google **ID token** via the native `@react-native-google-signin` library and posts it to a new Convex action `verifyGoogleAndLogin`. That action verifies the token server-side, matches an `active` `team_member` by email, then signs that member into Supabase under their existing `{phone}@vishful.local` identity — producing a token identical to `verifyOtpAndLogin`. Nothing downstream (`getSession`, role routing, `lib/auth.tsx`) changes.

**Tech Stack:** Expo SDK 52 (React Native 0.76, new architecture), TypeScript, Convex (Supabase service-role backend), `@react-native-google-signin/google-signin`.

## Global Constraints

- **Expo SDK 52**, `newArchEnabled: true`. Install native deps via `npx expo install` (never raw `npm install`) so versions are pinned to the SDK.
- **No test framework exists.** Automated per-task verification = `npx tsc --noEmit` (must be clean). Runtime verification requires an EAS **development build** and is deferred (see Rollout Gating).
- **Staff only.** Tenants must remain on phone-OTP, untouched.
- **Invite-only preserved.** Only a pre-existing, `active` `team_member` whose Google email (verified) is on record may authenticate.
- **Return shape must be identical** to `convex/otpAuth.ts` `verifyOtpAndLogin`: `{ success, token, user_type, user: { userId, userName, phone, role, organizationId, organizationName, supabaseUserId } }`.
- **Web client ID** is read on the client from `process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and on the backend from the Convex env var `GOOGLE_WEB_CLIENT_ID`. Both are the **same** Google "Web application" OAuth client ID (it is the idToken `aud`).
- **Do not modify `convex/otpAuth.ts`.** googleAuth replicates the small amount of Supabase sign-in logic locally to avoid risk to the primary login path (intentional, documented duplication).
- Commit after every task. Do not deploy Convex (blocked in this environment) — deploy is a downstream manual step.

## Rollout Gating (read before implementing)

Two steps are external to this plan and gate the feature going live end-to-end. The code is fully written and type-checked here regardless:
1. **Convex deploy is blocked** in this environment — `convex/googleAuth.ts` + the `GOOGLE_WEB_CLIENT_ID` env var only take effect when someone with Convex access deploys.
2. **A dev build is required** — the native module cannot run in Expo Go. Task 6 documents the Google Cloud + EAS dev-build runbook.

## File Structure

- `package.json` — add `@react-native-google-signin/google-signin` (Task 1).
- `app.json` — add the config plugin (Task 1).
- `convex/googleAuth.ts` — **new**, the `verifyGoogleAndLogin` action (Task 2).
- `lib/supabaseService.ts` — add the `verifyGoogleAndLogin` client wrapper (Task 3).
- `lib/googleAuth.ts` — **new**, `configureGoogleSignin()` + `signInWithGoogle()` (Task 4).
- `screens/LoginScreen.tsx` — add the button, handler, and one-time configure (Task 5).
- `docs/superpowers/plans/google-signin-setup-runbook.md` — **new**, manual Google Cloud + EAS steps (Task 6).

---

### Task 1: Add the native dependency and config plugin

**Files:**
- Modify: `package.json` (dependency added by the installer)
- Modify: `app.json` (add to `expo.plugins`)

**Interfaces:**
- Produces: the `@react-native-google-signin/google-signin` module + its config plugin, available to Tasks 4–5.

- [ ] **Step 1: Install the library (SDK-pinned)**

Run from the project root:

```bash
npx expo install @react-native-google-signin/google-signin
```

- [ ] **Step 2: Register the config plugin in `app.json`**

Add the plugin so the native code is compiled into dev/standalone builds. Edit `app.json` — add a `plugins` array inside `expo` (there is none today):

```json
{
  "expo": {
    "name": "Vishful Spaces",
    "slug": "vishful-spaces",
    "plugins": [
      "@react-native-google-signin/google-signin"
    ]
  }
}
```

Place the `"plugins"` key alongside the existing top-level `expo` keys (e.g. right after `"description"`). Do not remove or reorder existing keys.

- [ ] **Step 3: Verify config is valid and types compile**

Run:

```bash
npx expo config --type public > /dev/null && npx tsc --noEmit
```

Expected: `expo config` prints nothing to stderr (valid config), `tsc` exits 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json app.json
git commit -m "feat(auth): add @react-native-google-signin dependency + plugin"
```

---

### Task 2: Backend action `verifyGoogleAndLogin`

**Files:**
- Create: `convex/googleAuth.ts`

**Interfaces:**
- Consumes: `process.env.GOOGLE_WEB_CLIENT_ID`, `process.env.SUPABASE_URL`, `process.env.SUPABASE_SERVICE_ROLE_KEY`; the `getSupabase()` helper from `./lib/supabaseAdmin` (same import `convex/otpAuth.ts` uses).
- Produces: `api.googleAuth.verifyGoogleAndLogin({ idToken: string })` returning `{ success, token?, user_type?, user?, message? }` — the same shape as `api.otpAuth.verifyOtpAndLogin`, consumed by Task 3.

- [ ] **Step 1: Create `convex/googleAuth.ts`**

```typescript
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
      const { data: teamMember } = await sb
        .from("team_members")
        .select("id, first_name, last_name, status, user_id, phone")
        .ilike("email", email)
        .maybeSingle();

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
        const { data: roleData } = await sb
          .from("user_roles")
          .select("role")
          .eq("user_id", teamMember.user_id)
          .maybeSingle();
        if (roleData?.role) resolvedRole = roleData.role;
      }
      if (resolvedRole === "team_member" && authUserId) {
        const { data: roleData } = await sb
          .from("user_roles")
          .select("role")
          .eq("user_id", authUserId)
          .maybeSingle();
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
```

- [ ] **Step 2: Regenerate Convex API types (offline codegen — no deploy)**

Run:

```bash
npx convex codegen
```

Expected: updates `convex/_generated/api.d.ts` so `api.googleAuth.verifyGoogleAndLogin` exists. (If codegen requires a login/deploy connection and fails, skip it — Task 3 will still typecheck once the file exists because the generated `api` is derived from the `convex/` directory; note the failure and continue.)

- [ ] **Step 3: Verify types compile**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0. If `api.googleAuth` is reported missing, re-run `npx convex codegen`.

- [ ] **Step 4: Commit**

```bash
git add convex/googleAuth.ts convex/_generated
git commit -m "feat(auth): add verifyGoogleAndLogin Convex action (staff email match)"
```

---

### Task 3: Client service wrapper

**Files:**
- Modify: `lib/supabaseService.ts` (add one exported function near `verifyOtpAndLogin`, ~line 33–41)

**Interfaces:**
- Consumes: `api.googleAuth.verifyGoogleAndLogin` (Task 2); the existing `client` + `api` imports at the top of the file.
- Produces: `verifyGoogleAndLogin(idToken: string): Promise<{ success: boolean; token?: string; user?: any; user_type?: string; message?: string }>`, consumed by Task 5.

- [ ] **Step 1: Add the wrapper**

Insert directly after the existing `verifyOtpAndLogin` function (mirror its style):

```typescript
export async function verifyGoogleAndLogin(idToken: string): Promise<{
  success: boolean;
  token?: string;
  user?: any;
  user_type?: string;
  message?: string;
}> {
  return client.action(api.googleAuth.verifyGoogleAndLogin, { idToken });
}
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add lib/supabaseService.ts
git commit -m "feat(auth): add verifyGoogleAndLogin client service wrapper"
```

---

### Task 4: Google sign-in wrapper `lib/googleAuth.ts`

**Files:**
- Create: `lib/googleAuth.ts`

**Interfaces:**
- Consumes: `@react-native-google-signin/google-signin` (Task 1); `process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.
- Produces:
  - `configureGoogleSignin(): void` — call once before signing in.
  - `signInWithGoogle(): Promise<{ ok: true; idToken: string } | { ok: false; cancelled: boolean; message: string }>` — consumed by Task 5.

- [ ] **Step 1: Create `lib/googleAuth.ts`**

```typescript
import {
  GoogleSignin,
  statusCodes,
  isSuccessResponse,
  isCancelledResponse,
} from "@react-native-google-signin/google-signin";

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || "";

let configured = false;

export function configureGoogleSignin(): void {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    offlineAccess: false,
  });
  configured = true;
}

export type GoogleSignInResult =
  | { ok: true; idToken: string }
  | { ok: false; cancelled: boolean; message: string };

export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  try {
    configureGoogleSignin();
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();

    if (isCancelledResponse(response)) {
      return { ok: false, cancelled: true, message: "" };
    }
    if (isSuccessResponse(response)) {
      const idToken = response.data.idToken;
      if (!idToken) {
        return { ok: false, cancelled: false, message: "Google didn't return a sign-in token. Please try again." };
      }
      return { ok: true, idToken };
    }
    return { ok: false, cancelled: false, message: "Google sign-in failed. Please try again." };
  } catch (err: any) {
    if (err?.code === statusCodes.SIGN_IN_CANCELLED) {
      return { ok: false, cancelled: true, message: "" };
    }
    if (err?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      return { ok: false, cancelled: false, message: "Google Play Services is unavailable on this device." };
    }
    console.warn("[googleAuth] signIn error:", err?.message);
    return { ok: false, cancelled: false, message: "Google sign-in failed. Please try again." };
  }
}
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0. (If the installed library version does not export `isSuccessResponse`/`isCancelledResponse`, the compiler will flag it — in that older version, `signIn()` returns `userInfo` directly and throws `statusCodes.SIGN_IN_CANCELLED` on cancel; adapt `signInWithGoogle` to read `userInfo.idToken` and rely on the catch block. Verify against the installed version's `.d.ts` before changing.)

- [ ] **Step 3: Commit**

```bash
git add lib/googleAuth.ts
git commit -m "feat(auth): add native Google sign-in wrapper"
```

---

### Task 5: LoginScreen — button, handler, one-time configure

**Files:**
- Modify: `screens/LoginScreen.tsx`

**Interfaces:**
- Consumes: `signInWithGoogle`, `configureGoogleSignin` (Task 4); `sb.verifyGoogleAndLogin` (Task 3); the existing `login` from `useAuth()`.

- [ ] **Step 1: Import the wrapper**

Add after the existing `import * as sb from '../lib/supabaseService';` (line 10):

```typescript
import { signInWithGoogle, configureGoogleSignin } from '../lib/googleAuth';
```

- [ ] **Step 2: Configure Google on mount**

Inside the component, add a mount effect (near the existing resend-cleanup effect, ~line 57):

```typescript
useEffect(() => { configureGoogleSignin(); }, []);
```

- [ ] **Step 3: Add the handler**

Add alongside the other handlers (after `handleSendOTP`, ~line 118):

```typescript
const handleGoogleSignIn = async () => {
  setLoading(true);
  setError('');
  setShowSignupPrompt(false);
  try {
    const result = await signInWithGoogle();
    if (!result.ok) {
      if (!result.cancelled && result.message) setError(result.message);
      return;
    }
    const auth = await sb.verifyGoogleAndLogin(result.idToken);
    if (auth.success && auth.token) {
      await login(auth.token, auth.user as any);
    } else {
      setError(auth.message || 'Google sign-in failed. Please try again.');
    }
  } catch (err) {
    setError('Google sign-in failed. Please try again.');
  } finally {
    setLoading(false);
  }
};
```

- [ ] **Step 4: Add the button + divider (phone step only)**

In the `step === 'phone'` block, immediately after the closing `</View>` of `styles.panel` (the mobile-number card, ~line 322) and before the Privacy Policy `TouchableOpacity`, insert:

```tsx
<View style={styles.orRow}>
  <View style={styles.orLine} />
  <Text style={styles.orText}>OR</Text>
  <View style={styles.orLine} />
</View>

<TouchableOpacity activeOpacity={0.9} onPress={handleGoogleSignIn} disabled={loading} style={styles.googleBtn}>
  <Ionicons name="logo-google" size={18} color={C.warmWhite} />
  <Text style={styles.googleBtnText}>Continue with Google</Text>
</TouchableOpacity>
```

- [ ] **Step 5: Add the styles**

Add to the `StyleSheet.create({ ... })` object (before the closing `});`, near the `linkBtn` styles):

```typescript
orRow: {
  flexDirection: 'row',
  alignItems: 'center',
  marginTop: 22,
  gap: 12,
},
orLine: {
  flex: 1,
  height: 1,
  backgroundColor: 'rgba(255,255,255,0.12)',
},
orText: {
  fontSize: 11,
  fontWeight: '700',
  letterSpacing: 1.5,
  color: C.mauveDim,
},
googleBtn: {
  marginTop: 18,
  height: 54,
  borderRadius: 14,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  backgroundColor: 'rgba(255,255,255,0.06)',
  borderWidth: 1.5,
  borderColor: 'rgba(255,255,255,0.14)',
},
googleBtnText: {
  color: C.warmWhite,
  fontSize: 15,
  fontWeight: '700',
  letterSpacing: 0.2,
},
```

- [ ] **Step 6: Verify types compile**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add screens/LoginScreen.tsx
git commit -m "feat(auth): add Continue with Google button to LoginScreen"
```

---

### Task 6: Setup runbook (Google Cloud + EAS dev build)

**Files:**
- Create: `docs/superpowers/plans/google-signin-setup-runbook.md`

This task produces documentation only — no code. It captures the manual, external steps required to make the feature live (deferred, per Rollout Gating).

- [ ] **Step 1: Write the runbook**

Create `docs/superpowers/plans/google-signin-setup-runbook.md` with:

```markdown
# Google Sign-In — Setup Runbook (manual, external)

## 1. Google Cloud Console
1. Create/confirm a project + configure the OAuth consent screen.
2. Create an OAuth client of type **Web application** → copy its **Client ID**.
   This single ID is used in BOTH places below (it is the idToken `aud`).
3. Create an OAuth client of type **Android**:
   - Package name: `in.co.vishful.spaces`
   - SHA-1: register **every** signing cert's SHA-1 (see spec — Certificate A `C4:56:...:76:5E`, Certificate B `AC:E8:...:FE:65`, plus the dev-build debug SHA-1 from `eas credentials`).

## 2. Wire the Web Client ID
- **Client:** set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<web client id>` (in `.env` for local, and in `eas.json` build profile `env` for builds).
- **Backend:** set Convex env var `GOOGLE_WEB_CLIENT_ID=<same web client id>` (Convex dashboard → Settings → Environment Variables), then deploy `convex/googleAuth.ts`.

## 3. Build & test
1. `eas build --profile development --platform android` (a dev client — Expo Go cannot run the native module).
2. Install the dev build; ensure `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` was present at build time.
3. Set one active `team_member`'s `email` to your Google account's email.
4. Launch → "Continue with Google" → native picker → should land on the admin drawer.
5. Negative check: a Google account whose email is not a team member → "contact administrator" message.
6. Regression: phone-OTP (`9876543210 → 123456`) still works.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/google-signin-setup-runbook.md
git commit -m "docs(auth): add Google Sign-In setup runbook"
```

---

## Self-Review

**Spec coverage:**
- Staff-only, email match → Task 2 (`ilike` on `team_members.email`, `status === 'active'`). ✅
- Same Supabase session / return shape → Task 2 (mirrors otpAuth, identical return object). ✅
- Native `@react-native-google-signin` → Tasks 1, 4, 5. ✅
- Server-side token verification (aud + email_verified + iss + exp) → Task 2 `verifyGoogleIdToken`. ✅
- Client wrapper + LoginScreen button → Tasks 3, 5. ✅
- Config plugin, no scheme → Task 1. ✅
- Env vars (`GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`) → Global Constraints + Task 6. ✅
- Error handling (cancel silent, unverified email, no-match) → Tasks 2 + 4 + 5. ✅
- Rollout gating (deploy blocked, dev build) → Rollout section + Task 6. ✅
- Out of scope (tenants, self-signup, expo-auth-session, web) → not implemented. ✅

**Placeholder scan:** No TBD/TODO; all code blocks are concrete; the two "if the installed version differs" notes are explicit fallbacks, not placeholders.

**Type consistency:** `signInWithGoogle()` returns the discriminated union used verbatim in Task 5; `verifyGoogleAndLogin(idToken)` signature matches between Task 2 (action), Task 3 (wrapper), Task 5 (caller); return object keys match `AuthUser` in `lib/auth.tsx` (`userId`, `userName`, `phone`, `role`, `organizationId`, `organizationName`, `supabaseUserId`).

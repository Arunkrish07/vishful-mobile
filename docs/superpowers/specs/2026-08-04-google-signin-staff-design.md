# Google Sign-In (staff-only) — Design

**Date:** 2026-08-04
**Status:** Approved (design), pending implementation plan
**Scope:** Add "Continue with Google" as an alternative login for staff (`team_members`), matched by verified email. Tenants keep phone-OTP unchanged.

## Guiding principle

The Google flow must produce the **same Supabase session token** the existing OTP flow (`convex/otpAuth.ts` → `verifyOtpAndLogin`) already mints. Nothing downstream changes: `getSession` validation, role routing, and session persistence in `lib/auth.tsx` all keep working unmodified. Google login is a second front door onto the same identity.

## Why this shape (context)

- The app is **invite-only**: `sendOtp` rejects any phone not already in `team_members`/`tenants` ("User not found. Please contact your administrator."). There is no public signup. → Self-signup is out of scope.
- Auth is **phone-keyed**: Supabase Auth identity = `{phone}@vishful.local`; role resolved from `user_roles`.
- Google provides **email + name + Google ID, never a phone**. Both `team_members` and `tenants` carry an optional `email` column, so email-matching is feasible.
- **Staff** are the high-value, low-edge-case slice (work emails on file, benefit from no-SMS login). Tenants often lack an email and phone-OTP already serves them → tenant Google login is out of scope.
- **OAuth requires a development build on SDK 52.** Expo removed the `auth.expo.io` proxy, and Expo Go cannot customize the app scheme, so per Expo's docs *"Expo Go cannot be used for local development and testing of OAuth or OpenID Connect-enabled apps."* This holds for **any** Google library — there is no Expo Go path. Since a dev build is required regardless, native `@react-native-google-signin` is chosen for its native account-picker UX and direct use of the registered SHA-1. (An earlier draft picked `expo-auth-session` on the false premise that it ran in Expo Go; that premise was corrected against the Expo docs.)

## Decisions

| Decision | Choice |
|---|---|
| Who | Staff only (`team_members`); tenants unchanged |
| Mapping | Match Google `email` → `team_members.email` (case-insensitive), require `status = 'active'` |
| Client library | `@react-native-google-signin/google-signin` (native) — requires a dev build |
| Token verification | Server-side in a Convex action (never trust the client) |
| Session minting | Reuse the exact Supabase admin sign-in path from `verifyOtpAndLogin` under `{phone}@vishful.local` |
| Return shape | Identical to `verifyOtpAndLogin` (`{ success, token, user, user_type }`) |

## Components

### 1. Google Cloud Console (manual setup, guided)
- OAuth consent screen configured.
- **Web application** OAuth client → produces the **Web Client ID**. Passed to `GoogleSignin.configure({ webClientId })` and used as the `aud` value the backend verifies against.
- **Android** OAuth client registered with package `in.co.vishful.spaces` + the SHA-1(s) — **required** for the native Android sign-in flow to succeed.

Fingerprints on record (TWO distinct certificates). For Google Sign-In, register
**every** SHA-1 the app may be signed with on the Android OAuth client — Play App
Signing key, upload key, and debug key as applicable. Which cert is which
(upload vs Play App Signing vs debug) is TBD — to be confirmed in the plan, but
does not block setup since all are registered.

**Certificate A:**
- MD5: `60:D1:B9:33:0E:53:7A:42:B1:68:3D:75:1A:2B:03:2A`
- SHA-1: `C4:56:4A:A4:BB:14:E0:65:68:8A:05:8D:6C:9B:36:B2:91:65:76:5E`
- SHA-256: `0E:96:15:C3:85:B3:03:88:76:28:F6:67:94:42:9A:4B:DE:30:2A:E0:55:05:E8:56:19:87:27:AE:19:4A:82:36`

**Certificate B:**
- MD5: `93:1C:73:32:6F:F3:4A:94:D6:0C:F7:B4:3A:87:FF:2F`
- SHA-1: `AC:E8:12:1A:46:93:56:39:D3:26:2E:31:9B:C8:9D:CD:36:B6:FE:65`
- SHA-256: `EF:0E:DC:76:66:DE:22:0A:9D:94:D6:10:EB:58:8D:AC:17:D9:FB:FD:3A:87:9E:66:26:1D:E4:B4:67:57:1A:86`

### 2. `app.json` + config plugin
- Add `"@react-native-google-signin/google-signin"` to `expo.plugins` so the library's native code is compiled into the dev/standalone build.
- No custom URL scheme is required for the native flow — Android identifies the app by package (`in.co.vishful.spaces`) + SHA-1.

### 3. `lib/googleAuth.ts` (new)
- Thin wrapper over `@react-native-google-signin/google-signin`.
- `configureGoogleSignin()` → `GoogleSignin.configure({ webClientId: <WEB_CLIENT_ID>, offlineAccess: false })`. The `webClientId` is the Web OAuth client ID and becomes the idToken `aud`.
- `signInWithGoogle()` → `GoogleSignin.hasPlayServices()` → `GoogleSignin.signIn()` → returns the **ID token**. User-cancel (`statusCodes.SIGN_IN_CANCELLED`) is surfaced as a benign "cancelled" result, not an error.
- New dependency: `@react-native-google-signin/google-signin` (native module — installed via `npx expo install`; only runs in a dev/standalone build, never Expo Go).

### 4. `convex/googleAuth.ts` (new)
Action `verifyGoogleAndLogin({ idToken })`:
1. Verify token server-side: `aud === process.env.GOOGLE_WEB_CLIENT_ID`, `email_verified === true`, `exp` not passed, issuer is Google. (Via `https://oauth2.googleapis.com/tokeninfo?id_token=…` or `google-auth-library` `verifyIdToken`.)
2. Extract `email`, lowercase it.
3. Look up `team_members` by email (case-insensitive). No match → `{ success:false, message:"This Google account isn't linked to a staff member. Contact your administrator." }`. `status !== 'active'` → status-specific denial.
4. Build `{phone}@vishful.local` from the member's `phone`; reuse the exact create-or-update-password + `signInWithPassword` pattern from `verifyOtpAndLogin` to mint an `access_token`.
5. Resolve role from `user_roles` (same lookup logic as `verifyOtpAndLogin`).
6. Return `{ success:true, token, user_type:'team_member', user:{ userId, userName, phone, role, organizationId, organizationName, supabaseUserId } }` — identical shape to the OTP action.
- New Convex env var: `GOOGLE_WEB_CLIENT_ID`.

### 5. `lib/supabaseService.ts`
- Add `verifyGoogleAndLogin(idToken: string)` calling the Convex action, mirroring the existing OTP service functions.

### 6. `LoginScreen`
- "Continue with Google" button below the existing OTP card (dusk styling, consistent with the current design).
- Flow: tap → `signInWithGoogle()` → on success get `idToken` → `sb.verifyGoogleAndLogin(idToken)` → on `success` call `auth.login(token, user)` → routed by role exactly like OTP. On failure show the returned message; user-cancel is silent.

## Data flow

```
Tap "Continue with Google"
  → GoogleSignin.signIn() opens the native Google account picker
  → app receives idToken
  → Convex verifyGoogleAndLogin(idToken)
       verify aud + email_verified server-side
       match team_members by email (active only)
       Supabase admin sign-in as {phone}@vishful.local  → access_token
       resolve role from user_roles
  → { token, user }
  → auth.login(token, user)  → role routing (same as OTP)
```

## Error handling

| Case | Behaviour |
|---|---|
| User cancels/dismisses Google consent | Silent, no error toast |
| id_token invalid / expired / wrong `aud` | Generic "Google sign-in failed. Please try again." |
| `email_verified === false` | "Your Google email isn't verified." |
| No matching **active** `team_member` | "This Google account isn't linked to a staff member. Contact your administrator." |
| Network / offline | Same handling as the OTP path |

## Security

- Token audience and `email_verified` are checked **server-side**; the client is never trusted.
- Invite-only model preserved: only a pre-existing, `active` `team_member` whose verified email is on record can authenticate.
- Tenants are entirely unaffected.

## Testing

- **Build prerequisite:** an EAS **development build** (`eas build --profile development`) installed on the device/emulator — Google Sign-In cannot run in Expo Go. Local `expo run:android` is unavailable (managed workflow, Java not on PATH), so EAS is the route.
- **Data prerequisite:** one `active` `team_member` whose `email` equals a real Google account signable-in on the device.
- **Happy path (dev build):** Continue with Google → native account picker → lands on the admin drawer with the correct role.
- **Negative path:** Google account whose email is not a `team_member` → rejected with the "contact administrator" message.
- **Regression:** tenant phone-OTP login unchanged; existing `9876543210 → 123456` demo path still works.

## Rollout gating (known constraints)

The code (client + backend) can be written and type-checked in this environment, but two steps are gated on external access before the feature is live end-to-end:
1. **Convex deploy is blocked here** (no account access). `convex/googleAuth.ts` and the `GOOGLE_WEB_CLIENT_ID` env var only take effect once someone with Convex access deploys — bundle it with any other deploy-pending changes.
2. **A dev build is required** to exercise the native module. Until an EAS development build exists with the Google client IDs registered, the button will not complete a sign-in.

## Out of scope (YAGNI)

- Tenant Google login
- Self-signup / public registration
- `expo-auth-session` (browser flow) — superseded by the native library
- Web-platform Google login
- Account-linking UI (e.g. "link your Google account" in settings)

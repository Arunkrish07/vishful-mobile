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
- Dev loop is **Expo Go**; `expo-auth-session` (web OAuth) runs in **both Expo Go and the EAS build** with one code path, unlike native `@react-native-google-signin` which needs a dev build for every test.

## Decisions

| Decision | Choice |
|---|---|
| Who | Staff only (`team_members`); tenants unchanged |
| Mapping | Match Google `email` → `team_members.email` (case-insensitive), require `status = 'active'` |
| Client library | `expo-auth-session` (web-based OAuth) |
| Token verification | Server-side in a Convex action (never trust the client) |
| Session minting | Reuse the exact Supabase admin sign-in path from `verifyOtpAndLogin` under `{phone}@vishful.local` |
| Return shape | Identical to `verifyOtpAndLogin` (`{ success, token, user, user_type }`) |

## Components

### 1. Google Cloud Console (manual setup, guided)
- OAuth consent screen configured.
- **Web application** OAuth client → produces the **Web Client ID**. Used as (a) the `expo-auth-session` client ID and (b) the `aud` value the backend verifies.
- **Android** OAuth client registered with package `in.co.vishful.spaces` + the provided **SHA-1** fingerprint (`C4:56:4A:A4:BB:14:E0:65:68:8A:05:8D:6C:9B:36:B2:91:65:76:5E`), for the standalone build's redirect. (Not required for the Expo Go proxy path, but needed for the EAS build.)

Fingerprints on record for the app-signing certificate:
- MD5: `60:D1:B9:33:0E:53:7A:42:B1:68:3D:75:1A:2B:03:2A`
- SHA-1: `C4:56:4A:A4:BB:14:E0:65:68:8A:05:8D:6C:9B:36:B2:91:65:76:5E`
- SHA-256: `0E:96:15:C3:85:B3:03:88:76:28:F6:67:94:42:9A:4B:DE:30:2A:E0:55:05:E8:56:19:87:27:AE:19:4A:82:36`

### 2. `app.json`
- Add `"scheme": "vishfulspaces"` under `expo` so the standalone EAS build can receive the OAuth redirect (`vishfulspaces://`). Expo Go uses Expo's auth proxy automatically.

### 3. `lib/googleAuth.ts` (new)
- Thin wrapper over `expo-auth-session/providers/google`.
- Exposes `useGoogleAuth()` → `{ promptAsync, ready }`; on success returns the Google **ID token**.
- New dependencies: `expo-auth-session`, `expo-web-browser`, `expo-crypto` (versions pinned to Expo SDK 52 via `npx expo install`).

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
- Flow: tap → `promptAsync()` → on success get `id_token` → `sb.verifyGoogleAndLogin(idToken)` → on `success` call `auth.login(token, user)` → routed by role exactly like OTP. On failure show the returned message.

## Data flow

```
Tap "Continue with Google"
  → expo-auth-session opens Google consent (browser / Custom Tab)
  → app receives id_token
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

- **Prerequisite:** one `active` `team_member` whose `email` equals a real Google account signable-in on the emulator browser.
- **Happy path (Expo Go):** Continue with Google → lands on the admin drawer with the correct role.
- **Negative path:** Google account whose email is not a `team_member` → rejected with the "contact administrator" message.
- **Regression:** tenant phone-OTP login unchanged; existing `9876543210 → 123456` demo path still works.

## Out of scope (YAGNI)

- Tenant Google login
- Self-signup / public registration
- Native `@react-native-google-signin`
- Account-linking UI (e.g. "link your Google account" in settings)

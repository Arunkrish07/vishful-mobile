# Login screen redesign — design

Date: 2026-11-23
Branch: feat/ui-redesign-premium
File: screens/LoginScreen.tsx (full rewrite)

## Intent / why
Make the first screen users see feel premium and modern, and make OTP entry
faster and more delightful — a living mesh-gradient background and an animated,
auto-verifying OTP step with a success animation.

## Goals
1. **Animated mesh-gradient background** — a deep indigo/navy base with 3 large,
   softly-blurred colour blobs (blue → indigo → violet) that slowly drift and
   breathe, giving a "living mesh" feel. Large display branding; frosted glass
   card; inputs that glow when focused.
2. **OTP step, auto-verify + success animation:**
   - Each cell *pops* (scale spring) as a digit lands; the active cell glows.
   - When the 6th digit is entered it **verifies automatically** (no button tap).
   - On success → a **drawn checkmark** animation (SVG stroke draw + ring), then
     it enters the app.
   - On wrong code → the row **shakes**, clears, and shows the error.
   - **SMS autofill** (Android `sms-otp` / iOS one-time-code) so the code can be
     one-tapped from the notification.
3. Keep the flow: enhanced **splash** → **phone** → **otp**, with smooth
   animated transitions between steps. Keep resend countdown + change-number.

## Non-goals / anti-goals
- No change to auth: still `sb.sendOtp` / `sb.verifyOtpAndLogin` / `login()`,
  phone-only, auto-role. No password, no new auth steps.
- **No new dependencies** — use what's installed (RN `Animated`, `expo-blur`,
  `expo-linear-gradient`, `react-native-svg`).
- Don't touch other screens or the Privacy Policy nav.

## Decisions (confirmed with user)
- Look: **animated mesh gradient** (bold shifting blue/violet, frosted card,
  glowing input edges) on a dark base.
- OTP: **auto-verify on 6th digit + drawn success checkmark**.

## Approach
- **Animation engine:** RN `Animated` (already used here, proven on web +
  native — the login also runs on web/a0.dev). Not Reanimated, to avoid
  react-native-web animation risk. Transforms/opacity use the native driver.
- **Background:** base `LinearGradient` + 3 absolutely-positioned blurred colour
  blobs animated with looping `Animated` drift/scale; optional soft `BlurView`.
- **Step transitions:** cross-fade + slide between phone and otp.
- **OTP:** per-cell `Animated.Value` scale pop; auto-verify in an effect when
  `otp.length === 6`; success overlay draws an SVG checkmark (`Animated` on
  `strokeDashoffset`) then calls `login()`; error triggers a shake `Animated`
  sequence and clears the field.

Rejected: Reanimated 4 (nicer springs, but web parity risk for a screen that
must work in the a0.dev web iframe). Rejected: a real GL/mesh shader (needs a
new dependency).

## Left to builder
- Tune blob colours/positions so the mesh reads premium, not noisy.
- If the SVG stroke-draw proves unreliable on web, fall back to a scale+fade
  checkmark with an expanding ring (same beat, simpler).
- Verify on device (Android Expo Go) + a quick web check.

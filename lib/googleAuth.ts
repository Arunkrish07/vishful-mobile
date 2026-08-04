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

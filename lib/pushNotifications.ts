// ─── Push notification registration ──────────────────────────────────────────
// Registers this device's native push token with the backend so the server can
// send notifications via convex/notifications.notifyUsers.
//
// IMPORTANT: native device push tokens are NOT available in Expo Go — this
// requires a custom dev/APK build. Every call is guarded so it silently no-ops
// (never throws) in Expo Go, on simulators, or when permission is denied.

import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import * as Device from 'expo-device';
import { client, api } from './convexApi';

let _lastRegisteredToken: string | null = null;

/** Best-effort: acquire the device push token and persist it against the user. */
export async function registerForPush(userId?: string | null, role?: string | null): Promise<void> {
  try {
    // Expo Go cannot register native push tokens (removed in SDK 53+).
    if (isRunningInExpoGo()) return;
    // Physical device only — emulators/simulators can't get a real push token.
    if (!Device.isDevice) return;
    const Notifications = await import('expo-notifications');

    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') return;

    if (Platform.OS === 'android') {
      // A default channel is required for Android notifications to display.
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.DEFAULT,
      }).catch(() => {});
    }

    // Native FCM/APNs token (throws in Expo Go — caught below).
    const { data: token } = await Notifications.getDevicePushTokenAsync();
    if (!token || token === _lastRegisteredToken) return;

    await client.action((api as any).notifications.registerDeviceToken, {
      token: String(token),
      userId: userId ?? null,
      role: role ?? null,
      platform: Platform.OS,
    });
    _lastRegisteredToken = String(token);
  } catch (err) {
    // Expected in Expo Go / when unsupported — never surface to the user.
    console.log('[push] registration skipped:', (err as any)?.message || err);
  }
}

/** Remove this device's token (e.g. on logout). Best-effort. */
export async function unregisterPush(): Promise<void> {
  try {
    if (!_lastRegisteredToken) return;
    await client.action((api as any).notifications.removeDeviceToken, { token: _lastRegisteredToken });
    _lastRegisteredToken = null;
  } catch (err) {
    console.log('[push] unregister skipped:', (err as any)?.message || err);
  }
}

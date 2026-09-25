// ─── DeleteAccountButton ──────────────────────────────────────────────────────
// Self-contained "Delete account" control shown wherever a user manages their
// session (admin Settings, Tenant profile, Technician profile). Submits a
// non-destructive deletion REQUEST via sb.requestAccountDeletion (the backend
// records it for the team per the published data-deletion policy), then signs the
// user out. Satisfies Google Play's in-app account-deletion requirement.
import React, { useState } from 'react';
import {
  TouchableOpacity, Text, Alert, ActivityIndicator,
  type ViewStyle, type StyleProp,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../lib/auth';
import * as sb from '../lib/supabaseService';

export default function DeleteAccountButton({ style }: { style?: StyleProp<ViewStyle> }) {
  const { token, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!token) {
      Alert.alert('Session expired', 'Please sign in again to delete your account.');
      return;
    }
    try {
      setBusy(true);
      const res = await sb.requestAccountDeletion(token);
      setBusy(false);
      if (res?.success) {
        Alert.alert(
          'Request submitted',
          'Your account deletion request has been received. We’ll remove your personal data within 30 days and confirm by email. Financial and transaction records are retained as required by law. You’ll now be signed out.',
          [{ text: 'OK', onPress: () => logout() }],
        );
      } else {
        Alert.alert('Could not submit', res?.message || 'Please try again later.');
      }
    } catch (e: any) {
      setBusy(false);
      Alert.alert('Could not submit', e?.message || 'Please try again later.');
    }
  };

  const confirm = () => {
    Alert.alert(
      'Delete your account?',
      'This submits a request to delete your account and personal data. Your personal information will be removed within 30 days. Financial and transaction records are retained as required by law. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Request deletion', style: 'destructive', onPress: () => submit() },
      ],
    );
  };

  return (
    <TouchableOpacity
      onPress={confirm}
      disabled={busy}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Delete account"
      style={[
        {
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
          borderRadius: 12, borderWidth: 1, borderColor: '#FECACA', backgroundColor: '#FEF2F2',
          paddingHorizontal: 14, paddingVertical: 11, opacity: busy ? 0.6 : 1,
        },
        style,
      ]}
    >
      {busy
        ? <ActivityIndicator size="small" color="#DC2626" />
        : <Ionicons name="trash-outline" size={16} color="#DC2626" />}
      <Text style={{ fontSize: 13, fontWeight: '800', color: '#DC2626' }}>
        {busy ? 'Submitting…' : 'Delete account'}
      </Text>
    </TouchableOpacity>
  );
}

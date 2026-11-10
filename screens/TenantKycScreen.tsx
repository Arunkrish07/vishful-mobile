import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as sb from '../lib/supabaseService';
import { useAuth } from '../lib/auth';
import { colors, spacing, fontSize } from '../lib/theme';
import { Button, Input, PickerSelect, DateField, GlassBackground, LoadingScreen } from '../components/shared';

const GENDERS = [
  { label: 'Male', value: 'Male' },
  { label: 'Female', value: 'Female' },
  { label: 'Other', value: 'Other' },
];
const FOOD = [
  { label: 'Vegetarian', value: 'Vegetarian' },
  { label: 'Non-Vegetarian', value: 'Non-Vegetarian' },
  { label: 'Eggetarian', value: 'Eggetarian' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function TenantKycScreen() {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const phone = user?.phone || '';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (v: string) => setF(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    (async () => {
      try {
        const d: any = await sb.getTenantDetails(phone);
        const t = d?.tenant || {};
        setF({
          first_name: t.first_name || '', last_name: t.last_name || '',
          gender: t.gender || '', date_of_birth: t.date_of_birth || '',
          food_preference: t.food_preference || '', profession: t.profession || '',
          email: t.email || '',
          address: t.address || '', city: t.city || '', state: t.state || '',
          pincode: t.pincode || '', permanent_address: t.permanent_address || '',
          emergency_contact_name: t.emergency_contact_name || '',
          emergency_contact_relationship: t.emergency_contact_relationship || '',
          emergency_contact_phone: t.emergency_contact_phone || '',
          aadhar_number: '', pan_number: '',
          bank_name: '', bank_account_holder: '', bank_account_number: '', bank_ifsc: '', bank_branch: '',
          company_name: t.company_name || '', designation: t.designation || '',
        });
      } catch { /* start blank */ }
      finally { setLoading(false); }
    })();
  }, [phone]);

  const submit = async () => {
    if (!phone) { Alert.alert('Not signed in', 'Please sign in again.'); return; }
    if (!f.first_name?.trim()) { Alert.alert('Required', 'First name is required.'); return; }
    if (!f.emergency_contact_name?.trim() || !f.emergency_contact_phone?.trim()) {
      Alert.alert('Required', 'An emergency contact name and phone are required for KYC.'); return;
    }
    const full_name = `${(f.first_name || '').trim()} ${(f.last_name || '').trim()}`.trim();
    setSaving(true);
    try {
      const res = await sb.updateTenantKyc(phone, { ...f, full_name, markComplete: true });
      if (res?.ok) {
        Alert.alert('KYC submitted', 'Your details were saved and your KYC is marked complete.', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      } else {
        Alert.alert('Could not save', res?.error || 'Please try again.');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not submit KYC.');
    } finally { setSaving(false); }
  };

  if (loading) return <LoadingScreen />;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={{ padding: 4 }}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Complete KYC</Text>
          <View style={{ width: 28 }} />
        </View>

        <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.intro}>Fill in your details to complete your KYC. Fields marked * are required.</Text>

          <Section title="Personal">
            <Input label="First Name *" value={f.first_name} onChangeText={set('first_name')} placeholder="First name" />
            <Input label="Last Name" value={f.last_name} onChangeText={set('last_name')} placeholder="Last name" />
            <PickerSelect label="Gender" value={f.gender} options={GENDERS} onSelect={set('gender')} />
            <View style={{ marginBottom: 14 }}>
              <Text style={styles.fieldLabel}>Date of Birth</Text>
              <DateField value={f.date_of_birth} onChange={set('date_of_birth')} />
            </View>
            <PickerSelect label="Food Preference" value={f.food_preference} options={FOOD} onSelect={set('food_preference')} />
            <Input label="Profession" value={f.profession} onChangeText={set('profession')} placeholder="Profession / occupation" />
            <Input label="Email" value={f.email} onChangeText={set('email')} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" />
          </Section>

          <Section title="Address">
            <Input label="Current Address" value={f.address} onChangeText={set('address')} placeholder="Current address" multiline />
            <Input label="City" value={f.city} onChangeText={set('city')} placeholder="City" />
            <Input label="State" value={f.state} onChangeText={set('state')} placeholder="State" />
            <Input label="Pincode" value={f.pincode} onChangeText={set('pincode')} placeholder="Pincode" keyboardType="numeric" />
            <Input label="Permanent Address" value={f.permanent_address} onChangeText={set('permanent_address')} placeholder="Permanent (home) address" multiline />
          </Section>

          <Section title="Emergency Contact">
            <Input label="Name *" value={f.emergency_contact_name} onChangeText={set('emergency_contact_name')} placeholder="Contact name" />
            <Input label="Relationship" value={f.emergency_contact_relationship} onChangeText={set('emergency_contact_relationship')} placeholder="e.g. Father, Spouse" />
            <Input label="Phone *" value={f.emergency_contact_phone} onChangeText={set('emergency_contact_phone')} placeholder="Contact phone" keyboardType="phone-pad" />
          </Section>

          <Section title="ID Proof">
            <Input label="Aadhaar Number" value={f.aadhar_number} onChangeText={set('aadhar_number')} placeholder="12-digit Aadhaar" keyboardType="numeric" />
            <Input label="PAN Number" value={f.pan_number} onChangeText={set('pan_number')} placeholder="PAN" autoCapitalize="none" />
          </Section>

          <Section title="Bank Details">
            <Input label="Bank Name" value={f.bank_name} onChangeText={set('bank_name')} placeholder="Bank name" />
            <Input label="Account Holder" value={f.bank_account_holder} onChangeText={set('bank_account_holder')} placeholder="Name on account" />
            <Input label="Account Number" value={f.bank_account_number} onChangeText={set('bank_account_number')} placeholder="Account number" keyboardType="numeric" />
            <Input label="IFSC" value={f.bank_ifsc} onChangeText={set('bank_ifsc')} placeholder="IFSC code" autoCapitalize="characters" />
            <Input label="Branch" value={f.bank_branch} onChangeText={set('bank_branch')} placeholder="Branch" />
          </Section>

          <Button title="Submit KYC" onPress={submit} loading={saving} icon="checkmark-circle-outline" />
          <Text style={styles.note}>Aadhaar/photo scanning is available on the web portal. You can update these details anytime.</Text>
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: '#E5E7EB',
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  intro: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.lg, lineHeight: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.primary, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 10 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#556274', marginBottom: 6 },
  note: { fontSize: 11, color: colors.textTertiary, textAlign: 'center', marginTop: 14, lineHeight: 16 },
});

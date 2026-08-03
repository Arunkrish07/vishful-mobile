import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius, fontSize } from '../lib/theme';

export default function PrivacyPolicyScreen() {
  const nav = useNavigation();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Privacy Policy</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.lastUpdated}>Last Updated: June 2025</Text>

        <Text style={styles.sectionTitle}>1. Introduction</Text>
        <Text style={styles.body}>
          Vishful PM Spaces LLP ("we", "our", "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your personal information when you use our property management mobile application.
        </Text>

        <Text style={styles.sectionTitle}>2. Data We Collect</Text>
        <Text style={styles.body}>We collect the following information:</Text>
        <Text style={styles.bullet}>• <Text style={styles.bold}>Phone Number</Text> — collected during sign-in for authentication purposes.</Text>
        <Text style={styles.bullet}>• <Text style={styles.bold}>One-Time Password (OTP)</Text> — generated and temporarily stored to verify your identity.</Text>
        <Text style={styles.bullet}>• <Text style={styles.bold}>KYC Information</Text> — name, email, and other details you provide during tenant registration.</Text>

        <Text style={styles.sectionTitle}>3. Purpose of Data Collection</Text>
        <Text style={styles.body}>Your data is collected solely for:</Text>
        <Text style={styles.bullet}>• <Text style={styles.bold}>Authentication</Text> — verifying your identity via phone number and OTP.</Text>
        <Text style={styles.bullet}>• <Text style={styles.bold}>App Functionality</Text> — enabling ticket management, property services, and communication with property managers.</Text>

        <Text style={styles.sectionTitle}>4. Data Sharing</Text>
        <Text style={styles.body}>
          We do <Text style={styles.bold}>not</Text> share your personal data with any third parties. Your information is used exclusively within the app for its intended functionality.
        </Text>

        <Text style={styles.sectionTitle}>5. Data Security</Text>
        <Text style={styles.body}>
          All data is encrypted in transit using industry-standard TLS/SSL protocols. We implement appropriate technical and organizational measures to protect your personal information against unauthorized access, alteration, or destruction.
        </Text>

        <Text style={styles.sectionTitle}>6. Data Retention</Text>
        <Text style={styles.body}>
          OTP codes are temporary and expire shortly after generation. Your phone number and profile data are retained as long as your account is active. You may request deletion at any time.
        </Text>

        <Text style={styles.sectionTitle}>7. Your Rights</Text>
        <Text style={styles.body}>You have the right to:</Text>
        <Text style={styles.bullet}>• Access the personal data we hold about you.</Text>
        <Text style={styles.bullet}>• Request correction of inaccurate data.</Text>
        <Text style={styles.bullet}>• Request deletion of your account and all associated data.</Text>

        <Text style={styles.sectionTitle}>8. Data Deletion Requests</Text>
        <Text style={styles.body}>
          To request deletion of your account and personal data, please contact us at the email address below. We will process your request within 30 days.
        </Text>

        <Text style={styles.sectionTitle}>9. Contact Us</Text>
        <Text style={styles.body}>
          For any questions, concerns, or data deletion requests, please contact:
        </Text>
        <Text style={[styles.body, styles.bold, { marginTop: spacing.sm }]}>
          support@vishfulpm.com
        </Text>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  backBtn: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  content: {
    padding: spacing.xxl,
  },
  lastUpdated: {
    fontSize: fontSize.xs,
    color: colors.textTertiary,
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  body: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  bullet: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 22,
    marginBottom: spacing.xs,
    paddingLeft: spacing.sm,
  },
  bold: {
    fontWeight: '600',
    color: colors.text,
  },
});

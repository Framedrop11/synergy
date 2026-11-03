/**
 * app/caregiver.tsx — Caregiver Alert Settings screen.
 *
 * Allows the patient to:
 *   - Configure an optional caregiver email address or phone number
 *   - View current verification status
 *   - Update alert timing (follow-up delay, caregiver alert delay)
 *   - Enable/disable skipped-dose alerts
 *   - Remove the caregiver contact entirely
 *
 * The caregiver has NO account, app, dashboard, or portal.
 * This screen is purely patient-facing configuration for one-way alert delivery.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import AntDesign from '@expo/vector-icons/AntDesign';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { authHeaders } from '@/utils/authStorage';
import { normalizeCaregiverPhone } from '@/utils/phoneNumber';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

interface CaregiverSettings {
  channel: 'email' | 'sms' | null;
  hasDestination: boolean;
  verified: boolean;
  alertsEnabled: boolean;
  recipientOptedOut: boolean;
}

interface AlertSettings {
  followUpMinutes: number;
  caregiverAlertMinutes: number;
  alertOnSkipped: boolean;
}

export default function CaregiverScreen() {
  const insets = useSafeAreaInsets();
  const topInset = Math.max(insets.top || 0, Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0, 32);

  const [saving, setSaving] = useState(false);

  const [caregiver, setCaregiver] = useState<CaregiverSettings>({
    channel: null,
    hasDestination: false,
    verified: false,
    alertsEnabled: false,
    recipientOptedOut: false,
  });
  const [alertSettings, setAlertSettings] = useState<AlertSettings>({
    followUpMinutes: 30,
    caregiverAlertMinutes: 45,
    alertOnSkipped: false,
  });

  // Form state
  const [selectedChannel, setSelectedChannel] = useState<'email' | 'sms'>('email');
  const [destination, setDestination] = useState('');
  const [followUpInput, setFollowUpInput] = useState('30');
  const [caregiverDelayInput, setCaregiverDelayInput] = useState('45');

  const fetchSettings = useCallback(async () => {
    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/user/caregiver`, { headers });
      if (response.ok) {
        const data = await response.json();
        setCaregiver(data.caregiver || {});
        const as = data.alertSettings || {};
        setAlertSettings({
          followUpMinutes: as.followUpMinutes ?? 30,
          caregiverAlertMinutes: as.caregiverAlertMinutes ?? 45,
          alertOnSkipped: as.alertOnSkipped ?? false,
        });
        setFollowUpInput(String(as.followUpMinutes ?? 30));
        setCaregiverDelayInput(String(as.caregiverAlertMinutes ?? 45));
        if (data.caregiver?.channel) setSelectedChannel(data.caregiver.channel);
      }
    } catch {
      Alert.alert('Error', 'Could not load caregiver settings. Check your connection.');
    } finally {
    }
  }, []);

  useEffect(() => {
    // fetchSettings performs asynchronous network synchronization after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSettings();
  }, [fetchSettings]);

  const saveContact = async () => {
    const rawDestination = destination.trim();
    const dest = selectedChannel === 'sms'
      ? normalizeCaregiverPhone(rawDestination)
      : rawDestination;
    if (!dest) {
      Alert.alert(
        selectedChannel === 'sms' ? 'Invalid phone' : 'Missing contact',
        selectedChannel === 'sms'
          ? 'Enter a valid phone number. Indian 10-digit mobile numbers are accepted; international numbers must include + and the country code.'
          : 'Enter a valid email address.'
      );
      return;
    }
    if (selectedChannel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) {
      Alert.alert('Invalid email', 'Enter a valid email address.');
      return;
    }
    setSaving(true);
    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/user/caregiver`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ channel: selectedChannel, destination: dest }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save');
      Alert.alert('Saved', data.message || 'Caregiver contact saved. A verification message will be sent once the messaging provider is configured.');
      setDestination('');
      await fetchSettings();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save caregiver contact.';
      if (message.toLowerCase().includes('delivery is not configured')) {
        const setup = selectedChannel === 'email'
          ? 'Email delivery is not configured on the server. Add SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, and EMAIL_FROM to the synergy-secrets environment group in Render, then redeploy the API and worker.'
          : 'SMS delivery is not configured on the server. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to the synergy-secrets environment group in Render, then redeploy the API and worker.';
        Alert.alert('Server setup required', setup);
      } else {
        Alert.alert('Error', message);
      }
    } finally {
      setSaving(false);
    }
  };

  const saveAlertSettings = async () => {
    const followUp = parseInt(followUpInput, 10);
    const caregiverDelay = parseInt(caregiverDelayInput, 10);

    if (isNaN(followUp) || followUp < 5 || followUp > 120) {
      Alert.alert('Invalid', 'Follow-up delay must be between 5 and 120 minutes.');
      return;
    }
    if (isNaN(caregiverDelay) || caregiverDelay <= followUp || caregiverDelay > 180) {
      Alert.alert('Invalid', 'Caregiver alert delay must be greater than the follow-up delay and at most 180 minutes.');
      return;
    }

    setSaving(true);
    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/user/alert-settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          followUpMinutes: followUp,
          caregiverAlertMinutes: caregiverDelay,
          alertOnSkipped: alertSettings.alertOnSkipped,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save');
      Alert.alert('Saved', 'Alert timing updated.');
      await fetchSettings();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save alert settings.');
    } finally {
      setSaving(false);
    }
  };

  const removeCaregiver = () => {
    Alert.alert(
      'Remove caregiver contact?',
      'This will disable all caregiver alerts and remove the stored contact. This does not delete your account.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const headers = await authHeaders();
              const response = await fetch(`${API_URL}/user/caregiver`, { method: 'DELETE', headers });
              if (!response.ok) throw new Error('Request failed');
              Alert.alert('Removed', 'Caregiver contact removed and alerts disabled.');
              await fetchSettings();
            } catch {
              Alert.alert('Error', 'Failed to remove caregiver contact.');
            }
          },
        },
      ]
    );
  };

  const resendVerification = async () => {
    setSaving(true);
    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/user/caregiver/resend-verification`, { method: 'POST', headers });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not resend verification.');
      Alert.alert('Verification sent', data.message || 'A new verification message was sent.');
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Could not resend verification.');
    } finally {
      setSaving(false);
    }
  };

  const toggleAlertOnSkipped = async (value: boolean) => {
    setAlertSettings((prev) => ({ ...prev, alertOnSkipped: value }));
    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/user/alert-settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ alertOnSkipped: value }),
      });
      if (!response.ok) throw new Error('Request failed');
    } catch {
      setAlertSettings((prev) => ({ ...prev, alertOnSkipped: !value }));
      Alert.alert('Error', 'Failed to update setting.');
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.container}>
        <StatusBar backgroundColor="#2A7BB5" barStyle="light-content" translucent />
        <View style={[styles.header, { paddingTop: topInset + 8 }]}>
          <TouchableOpacity onPress={() => router.back()}>
            <AntDesign name="arrow-left" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Caregiver Alerts</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          {/* What this is */}
          <View style={styles.infoCard}>
            <MaterialCommunityIcons name="information-outline" size={18} color="#2A7BB5" />
            <Text style={styles.infoText}>
              You can optionally add one contact who receives a simple one-way alert if a dose is unconfirmed past the configured delay. The contact has no account or portal.
            </Text>
          </View>

          {/* Current status */}
          <Text style={styles.sectionTitle}>Current Status</Text>
          <View style={styles.statusCard}>
            <StatusRow icon="link" label="Channel" value={caregiver.channel ?? 'Not configured'} />
            <StatusRow icon="email-check" label="Contact saved" value={caregiver.hasDestination ? 'Yes (hidden for privacy)' : 'No'} />
            <StatusRow icon="shield-check" label="Verified" value={caregiver.verified ? '✅ Yes' : '⚠️ Pending verification'} />
            <StatusRow icon="bell-check" label="Alerts enabled" value={caregiver.alertsEnabled ? 'Yes' : 'No'} />
            {caregiver.recipientOptedOut && (
              <StatusRow icon="bell-off" label="Opt-out" value="Recipient has opted out" negative />
            )}
            {caregiver.hasDestination && !caregiver.verified && (
              <TouchableOpacity style={styles.saveBtn} onPress={resendVerification} disabled={saving}>
                <Text style={styles.saveBtnText}>Resend verification message</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Configure contact */}
          <Text style={styles.sectionTitle}>Configure Contact</Text>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Alert channel</Text>
            <View style={styles.channelRow}>
              <TouchableOpacity
                style={[styles.channelBtn, selectedChannel === 'email' && styles.channelBtnActive]}
                onPress={() => setSelectedChannel('email')}
              >
                <MaterialCommunityIcons name="email-outline" size={16} color={selectedChannel === 'email' ? '#fff' : '#2A7BB5'} />
                <Text style={[styles.channelBtnText, selectedChannel === 'email' && styles.channelBtnTextActive]}>Email</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.channelBtn, selectedChannel === 'sms' && styles.channelBtnActive]}
                onPress={() => setSelectedChannel('sms')}
              >
                <MaterialCommunityIcons name="message-text-outline" size={16} color={selectedChannel === 'sms' ? '#fff' : '#2A7BB5'} />
                <Text style={[styles.channelBtnText, selectedChannel === 'sms' && styles.channelBtnTextActive]}>SMS</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.cardLabel}>
              {selectedChannel === 'email' ? 'Email address' : 'Phone number'}
            </Text>
            <TextInput
              style={styles.input}
              value={destination}
              onChangeText={setDestination}
              placeholder={selectedChannel === 'email' ? 'contact@example.com' : '10-digit India number or +country code'}
              placeholderTextColor="#A0AEC0"
              keyboardType={selectedChannel === 'email' ? 'email-address' : 'phone-pad'}
              autoCapitalize="none"
            />
            {selectedChannel === 'sms' && (
              <Text style={styles.privacyNote}>
                Indian 10-digit mobile numbers are saved with +91. For other countries, enter the +country code.
              </Text>
            )}
            <Text style={styles.privacyNote}>
              The destination is stored securely and never displayed after saving. A verification message will be sent to confirm consent before alerts are activated.
            </Text>
            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={saveContact}
              disabled={saving}
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save & send verification'}</Text>
            </TouchableOpacity>
          </View>

          {/* Alert timing */}
          <Text style={styles.sectionTitle}>Alert Timing</Text>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Patient follow-up delay (minutes after scheduled dose)</Text>
            <TextInput
              style={styles.input}
              value={followUpInput}
              onChangeText={setFollowUpInput}
              keyboardType="number-pad"
              maxLength={3}
            />
            <Text style={styles.cardLabel}>Caregiver alert delay (minutes after scheduled dose)</Text>
            <TextInput
              style={styles.input}
              value={caregiverDelayInput}
              onChangeText={setCaregiverDelayInput}
              keyboardType="number-pad"
              maxLength={3}
            />
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardLabel}>Alert caregiver when I skip a dose</Text>
                <Text style={styles.switchNote}>By default, caregiver alerts only fire when a dose is unconfirmed. Enable this to also send an alert when you explicitly mark a dose as skipped.</Text>
              </View>
              <Switch
                value={alertSettings.alertOnSkipped}
                onValueChange={toggleAlertOnSkipped}
                trackColor={{ true: '#2A7BB5' }}
              />
            </View>
            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={saveAlertSettings}
              disabled={saving}
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save timing'}</Text>
            </TouchableOpacity>
          </View>

          {/* Remove */}
          {caregiver.hasDestination && (
            <TouchableOpacity style={styles.removeBtn} onPress={removeCaregiver}>
              <AntDesign name="delete" size={16} color="#E53E3E" />
              <Text style={styles.removeBtnText}>Remove caregiver contact and disable alerts</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function StatusRow({ icon, label, value, negative }: { icon: string; label: string; value: string; negative?: boolean }) {
  return (
    <View style={styles.statusRow}>
      <MaterialCommunityIcons name={icon as any} size={16} color={negative ? '#E53E3E' : '#2A7BB5'} />
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={[styles.statusValue, negative && { color: '#E53E3E' }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F0F6FC' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingBottom: 16, backgroundColor: '#2A7BB5',
    elevation: 4,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#fff' },
  content: { padding: 16, paddingBottom: 40 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#4A5568', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 20, marginBottom: 8 },
  infoCard: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#EBF8FF',
    borderRadius: 10, padding: 12, gap: 10, marginBottom: 4,
  },
  infoText: { flex: 1, fontSize: 13, color: '#2C5282', lineHeight: 18 },
  statusCard: { backgroundColor: '#fff', borderRadius: 12, padding: 12, elevation: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E2E8F0' },
  statusLabel: { flex: 1, fontSize: 13, color: '#4A5568' },
  statusValue: { fontSize: 13, color: '#2D3748', fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, elevation: 1 },
  cardLabel: { fontSize: 13, color: '#4A5568', fontWeight: '600', marginBottom: 6, marginTop: 10 },
  input: {
    height: 48, borderWidth: 1.5, borderColor: '#CBD5E0', borderRadius: 10,
    paddingHorizontal: 12, fontSize: 15, color: '#2D3748', backgroundColor: '#fff',
  },
  channelRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  channelBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 40, borderRadius: 10, borderWidth: 1.5, borderColor: '#2A7BB5', gap: 6,
  },
  channelBtnActive: { backgroundColor: '#2A7BB5' },
  channelBtnText: { fontSize: 14, fontWeight: '600', color: '#2A7BB5' },
  channelBtnTextActive: { color: '#fff' },
  privacyNote: { fontSize: 11, color: '#718096', lineHeight: 16, marginTop: 6, marginBottom: 12 },
  saveBtn: {
    backgroundColor: '#2A7BB5', borderRadius: 10, height: 46,
    justifyContent: 'center', alignItems: 'center', marginTop: 4,
  },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, marginBottom: 4 },
  switchNote: { fontSize: 11, color: '#718096', lineHeight: 15, marginTop: 2 },
  removeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 24, paddingVertical: 12,
    borderWidth: 1, borderColor: '#FEB2B2', borderRadius: 10, backgroundColor: '#FFF5F5',
  },
  removeBtnText: { color: '#E53E3E', fontSize: 14, fontWeight: '600' },
});

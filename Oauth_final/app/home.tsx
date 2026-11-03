import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  AppState, View, Text, StyleSheet, TouchableOpacity,
  Alert, TextInput, Modal, StatusBar, ScrollView, Animated, Vibration, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import AntDesign from '@expo/vector-icons/AntDesign';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import DateTimePicker from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { authHeaders, clearAuth } from '@/utils/authStorage';
import { getNativeGoogleSignIn } from '@/utils/googleSignIn';
import ReminderLanguageInput from '@/components/ReminderLanguageInput';
import VoiceReminderInput from '@/components/VoiceReminderInput';
import { ParsedReminderDraft, ParsedReminderTime } from '@/utils/reminderAssistant';
import { enqueueAction, flushQueue, needsReviewCount } from '@/utils/offlineQueue';
import { getDeviceTimezone } from '@/utils/timezoneHelper';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

// ─── Notification helpers (gracefully degraded in Expo Go) ────────────────────
// expo-notifications remote push was removed from Expo Go in SDK 53.
// All calls are wrapped so the app still loads — notifications just won't fire.
let Notifications: typeof import('expo-notifications') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module must degrade safely when absent in Expo Go.
  Notifications = require('expo-notifications');
  Notifications!.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    } as any),
  });
} catch {
  console.warn('expo-notifications not available in this environment (Expo Go). Use a dev build for notifications.');
}

async function ensureNotificationChannel() {
  if (!Notifications) return;
  try {
    await Notifications.setNotificationChannelAsync('medication-reminders', {
      name: 'Medication Reminders',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      showBadge: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
  } catch (e) {
    console.error('Failed to create notification channel:', e);
  }
}

async function checkPermissionStatus(): Promise<'granted' | 'denied' | 'undetermined'> {
  if (!Notifications) return 'undetermined';
  try {
    const settings = await Notifications.getPermissionsAsync();
    if (settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      return 'granted';
    }
    return 'denied';
  } catch {
    return 'undetermined';
  }
}

async function requestPermissionsIfNeeded() {
  if (!Notifications) return;
  try {
    const status = await checkPermissionStatus();
    if (status === 'granted') return;
    const requested = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    if (!requested.granted) {
      Alert.alert(
        'Notifications Disabled',
        'Enable notifications in device Settings to receive scheduled medication reminders.'
      );
    }
  } catch (e) {
    console.warn('Error requesting notification permissions:', e);
  }
}

// ─── Reminder class ───────────────────────────────────────────────────────────
class Reminder {
  _id: string;
  medicationName: string;
  /** Patient-stated dosage, never AI-inferred. null when not provided. */
  dosage: string | null;
  time: string;
  timezone: string;
  repeating: boolean;
  notificationId: string | null;
  occurrenceId: string | null;
  /** active | paused | deleted */
  status: string;

  constructor(data: {
    _id: string;
    medicationName: string;
    dosage?: string | null;
    time: string;
    timezone?: string;
    repeating: boolean;
    notificationId?: string | null;
    occurrenceId?: string | null;
    status?: string;
  }) {
    this._id = data._id;
    this.medicationName = data.medicationName;
    this.dosage = data.dosage ?? null;
    this.time = data.time;
    this.timezone = data.timezone || 'UTC';
    this.repeating = data.repeating;
    this.notificationId = data.notificationId ?? null;
    this.occurrenceId = data.occurrenceId ?? null;
    this.status = data.status || 'active';
  }

  getFormattedTime(): string {
    return new Date(this.time).toLocaleString();
  }
}

// ─── Notification Scheduling Engine ──────────────────────────────────────────

async function cancelEscalationForMedication(medicationId: string) {
  if (!Notifications) return;
  try {
    const storedEscalationId = await AsyncStorage.getItem(`escalation_${medicationId}`);
    if (storedEscalationId) {
      await Notifications.cancelScheduledNotificationAsync(storedEscalationId).catch(() => {});
      await AsyncStorage.removeItem(`escalation_${medicationId}`);
    }
    const all = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
    for (const n of all) {
      const d = n.content.data as any;
      if (d?.medicationId === medicationId && d?.type === 'escalation') {
        await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Error cancelling escalation notification:', e);
  }
}

async function cancelEscalationForOccurrence(medicationId: string, occurrenceId: string | null) {
  if (!Notifications || !occurrenceId) return;
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    for (const notification of all) {
      const data = notification.content.data as any;
      if (data?.medicationId === medicationId && data?.occurrenceId === occurrenceId && data?.type === 'escalation') {
        await Notifications.cancelScheduledNotificationAsync(notification.identifier);
      }
    }
  } catch (error) {
    console.warn('Could not cancel this dose follow-up notification:', error);
  }
}

async function cancelAllNotificationsForMedication(reminder: Reminder) {
  if (!Notifications) return;
  try {
    if (reminder.notificationId) {
      await Notifications.cancelScheduledNotificationAsync(reminder.notificationId).catch(() => {});
    }
    await cancelEscalationForMedication(reminder._id);
    const all = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
    for (const n of all) {
      const d = n.content.data as any;
      if (d?.medicationId === reminder._id) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Error cancelling all notifications for reminder:', e);
  }
}

async function scheduleNotificationForSingleReminder(
  reminder: Reminder,
  headers: HeadersInit,
  followUpMinutes: number
): Promise<void> {
  if (!Notifications) return;
  const now = new Date();
  const to = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const response = await fetch(
    `${API_URL}/medications/${reminder._id}/occurrences?from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    { headers }
  );
  if (!response.ok) throw new Error('Could not load upcoming dose times for local notifications.');
  const payload = await response.json();
  const occurrences = (payload.occurrences || []).filter((o: any) => o.state === 'due');

  for (const occurrence of occurrences) {
    const dueAt = new Date(occurrence.scheduledFor);
    if (dueAt <= now) continue;
    const data = {
      medicationId: reminder._id,
      occurrenceId: occurrence._id,
      medicationName: reminder.medicationName,
    };
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '💊 PatientCareAI Medicine Reminder',
        body: `Time to take: ${reminder.medicationName}`,
        sound: 'default',
        vibrate: [0, 250, 250, 250],
        priority: Notifications.AndroidNotificationPriority.HIGH,
        data: { ...data, type: 'reminder' },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, channelId: 'medication-reminders', date: dueAt },
    });

    const followUpAt = new Date(dueAt.getTime() + followUpMinutes * 60_000);
    if (followUpAt > now) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '⏰ Reminder Follow-up',
          body: `Please check your ${reminder.medicationName} reminder.`,
          sound: 'default',
          vibrate: [0, 250, 250, 250],
          priority: Notifications.AndroidNotificationPriority.HIGH,
          data: { ...data, type: 'escalation' },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, channelId: 'medication-reminders', date: followUpAt },
      });
    }
  }
}

function formatClock(value: Date) {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function clockToDate(value: string | null) {
  const result = new Date();
  if (value) {
    const [hours, minutes] = value.split(':').map(Number);
    result.setHours(hours, minutes, 0, 0);
  }
  return result;
}

function formatClockLabel(value: string) {
  return clockToDate(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const topInset = Math.max(
    insets.top || 0,
    Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0,
    32
  );

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const remindersRef = useRef(reminders);
  const remindersFetchInProgress = useRef(false);
  useEffect(() => { remindersRef.current = reminders; }, [reminders]);
  const [loading, setLoading] = useState(false);
  const [notifPermission, setNotifPermission] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');

  const [medicineName, setMedicineName] = useState('');
  const [dosage, setDosage] = useState('');
  const [date, setDate] = useState(new Date());
  const [time, setTime] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [aiSchedule, setAiSchedule] = useState<ParsedReminderDraft | null>(null);
  const [aiTimePickerIndex, setAiTimePickerIndex] = useState<number | null>(null);
  const [editingReminder, setEditingReminder] = useState<Reminder | null>(null);
  const [isFormVisible, setIsFormVisible] = useState(false);
  const [voiceText, setVoiceText] = useState('');

  const [isProfileMenuVisible, setIsProfileMenuVisible] = useState(false);
  const [isMenuVisible, setIsMenuVisible] = useState(false);

  const [showDashboard, setShowDashboard] = useState(false);
  const [adherenceData, setAdherenceData] = useState<any[]>([]);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [totalTaken, setTotalTaken] = useState(0);
  const [totalSkipped, setTotalSkipped] = useState(0);
  const [totalUnconfirmed, setTotalUnconfirmed] = useState(0);
  const [totalDoses, setTotalDoses] = useState(0);

  // ── In-app notification banner state ────────────────────────────────────────
  const [activeBannerData, setActiveBannerData] = useState<{
    medicationId: string | null;
    occurrenceId: string | null;
    medicationName: string;
    message: string;
    type: 'reminder' | 'escalation';
  } | null>(null);
  const [bannerAnimY] = useState(new Animated.Value(-240));

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      await requestPermissionsIfNeeded();
      await ensureNotificationChannel();
      const perm = await checkPermissionStatus();
      setNotifPermission(perm);
      await fetchReminders();
      // Replay any dose actions that were queued while offline
      await flushQueue().catch(() => 0);
      const needsReview = await needsReviewCount();
      if (needsReview > 0) {
        Alert.alert('Action needs review', `${needsReview} offline action(s) could not be matched to a scheduled dose. Review your adherence history and contact your care team if needed.`);
      }
    })();

    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void checkPermissionStatus().then((permission) => {
          setNotifPermission(permission);
          return fetchReminders();
        });
        flushQueue().catch(() => {});
      }
    });

    let receivedSub: { remove: () => void } | null = null;
    let responseSub: { remove: () => void } | null = null;

    if (Notifications) {
      receivedSub = Notifications.addNotificationReceivedListener((notification) => {
        const data = notification.request.content.data as any;
        const body = notification.request.content.body || '';
        const medId = data?.medicationId || null;
        const isEscalation = data?.type === 'escalation';
        setActiveBannerData({
          medicationId: medId,
          occurrenceId: data?.occurrenceId || null,
          medicationName: data?.medicationName || 'Medication',
          message: body,
          type: isEscalation ? 'escalation' : 'reminder',
        });
        showBanner();
      });

      responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data as any;
        const medId = data?.medicationId;
        const isEscalation = data?.type === 'escalation';
        if (medId) {
          const matched = remindersRef.current.find((r) => r._id === medId);
          setActiveBannerData({
            medicationId: medId,
            occurrenceId: data?.occurrenceId || null,
            medicationName: matched?.medicationName || data?.medicationName || 'Medication',
            message: response.notification.request.content.body || '',
            type: isEscalation ? 'escalation' : 'reminder',
          });
          showBanner();
        }
      });
    }

    return () => {
      receivedSub?.remove();
      responseSub?.remove();
      appStateSubscription.remove();
    };
  // One-time native listener setup; fetchReminders is stable and listener callbacks read the latest reminders from remindersRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch reminders ─────────────────────────────────────────────────────────
  const fetchReminders = useCallback(async () => {
    if (remindersFetchInProgress.current) return;
    remindersFetchInProgress.current = true;
    setLoading(true);
    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/getReminders`, { headers });
      if (!response.ok) {
        if (response.status === 401) {
          Alert.alert('Session expired', 'Please log in again.');
          router.replace('/login');
        }
        return;
      }
      const data = await response.json();
      const mapped = await Promise.all((data.reminders as any[]).map(async (r) => {
        const reminder = new Reminder(r);
        if (reminder.status === 'active') {
          try {
            const from = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
            const to = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
            const occurrenceResponse = await fetch(`${API_URL}/medications/${reminder._id}/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers });
            if (occurrenceResponse.ok) {
              const occurrenceData = await occurrenceResponse.json();
              const pending = (occurrenceData.occurrences || []).filter((o: any) =>
                (o.state === 'due' || o.state === 'unconfirmed') &&
                new Date(o.scheduledFor).getTime() <= Date.now() + 60 * 60 * 1000
              );
              pending.sort((a: any, b: any) => Math.abs(new Date(a.scheduledFor).getTime() - Date.now()) - Math.abs(new Date(b.scheduledFor).getTime() - Date.now()));
              reminder.occurrenceId = pending[0]?._id ?? null;
            }
          } catch { /* The action endpoint can resolve a timestamp if this lookup is temporarily unavailable. */ }
        }
        return reminder;
      }));
      setReminders(mapped);
      await scheduleNotificationsForReminders(mapped);
    } catch (error) {
      console.error('Error fetching reminders:', error);
    } finally {
      remindersFetchInProgress.current = false;
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    if (notifPermission === 'granted') void fetchReminders();
  }, [fetchReminders, notifPermission]));

  // ── Notification scheduling ─────────────────────────────────────────────────
  const scheduleNotificationsForReminders = async (list: Reminder[]) => {
    if (!Notifications) return;
    try {
      const headers = await authHeaders();
      const settingsResponse = await fetch(`${API_URL}/user/caregiver`, { headers });
      const settings = settingsResponse.ok ? await settingsResponse.json() : {};
      const followUpMinutes = settings.alertSettings?.followUpMinutes ?? 30;
      for (const reminder of list) {
        await cancelAllNotificationsForMedication(reminder);
        if (reminder.status === 'active') {
          await scheduleNotificationForSingleReminder(reminder, headers, followUpMinutes);
        }
      }
    } catch (e) {
      console.error('Error scheduling reminders list:', e);
    }
  };

  // ── Form helpers ────────────────────────────────────────────────────────────
  const openCreateForm = () => {
    setEditingReminder(null);
    setMedicineName('');
    setDosage('');
    setDate(new Date());
    setTime(new Date());
    setAiSchedule(null);
    setAiTimePickerIndex(null);
    setIsFormVisible(true);
  };

  const openEditForm = (reminder: Reminder) => {
    const t = new Date(reminder.time);
    setEditingReminder(reminder);
    setMedicineName(reminder.medicationName);
    setDosage(reminder.dosage ?? '');
    setDate(t);
    setTime(t);
    setAiSchedule(null);
    setAiTimePickerIndex(null);
    setIsFormVisible(true);
  };

  const promptRepeatAndSave = () => {
    if (aiSchedule) {
      if (aiSchedule.times.some((slot) => !slot.time)) {
        Alert.alert('Choose each reminder time', 'Set a clock time for every listed dose before saving.');
        return;
      }
      const schedule = aiSchedule.times.map((slot) => `${slot.label}: ${formatClockLabel(slot.time!)}`).join('\n');
      Alert.alert(
        'Review AI suggestions',
        `${medicineName.trim()}\n${aiSchedule.frequency === 'daily' ? 'Repeats daily' : 'One-time'}\n${schedule}\n\nConfirm these times before creating reminders.`,
        [
          { text: 'Review', style: 'cancel' },
          { text: 'Create reminders', onPress: () => saveReminder(aiSchedule.frequency === 'daily', aiSchedule.times) },
        ]
      );
      return;
    }
    Alert.alert('Repeat Reminder', 'Should this reminder repeat daily?', [
      { text: 'No', onPress: () => saveReminder(false) },
      { text: 'Yes', onPress: () => saveReminder(true) },
    ]);
  };

  const saveReminder = async (repeat: boolean, aiTimes?: ParsedReminderTime[]) => {
    if (medicineName.trim() === '') { Alert.alert('Error', 'Please enter the medicine name.'); return; }

    let savedCount = 0;
    try {
      const scheduleTimes = aiTimes?.map((slot) => slot.time!) ?? [formatClock(time)];
      const reminderDateTimes = scheduleTimes.map((clockTime) => {
        const [hours, minutes] = clockTime.split(':').map(Number);
        const scheduled = new Date(date);
        scheduled.setHours(hours, minutes, 0, 0);
        if (repeat && scheduled <= new Date()) scheduled.setDate(scheduled.getDate() + 1);
        return scheduled;
      });
      if (reminderDateTimes.some((scheduled) => scheduled <= new Date())) {
        Alert.alert('Error', 'Please set a future time for the reminder.');
        return;
      }

      const headers = await authHeaders();
      const tz = getDeviceTimezone();
      // Dosage is optional and comes only from the patient's explicit entry.
      const enteredDosage = dosage.trim() || null;
      if (editingReminder) {
        const reminderDateTime = reminderDateTimes[0];
        const body = JSON.stringify({
          medicationName: medicineName.trim(),
          time: reminderDateTime.toISOString(),
          repeating: repeat,
          timezone: tz,
          dosage: enteredDosage,
        });
        await cancelAllNotificationsForMedication(editingReminder);
        const response = await fetch(`${API_URL}/medications/${editingReminder._id}`, { method: 'PUT', headers, body });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update.');
        const updatedReminder = new Reminder({ ...data.medication, _id: editingReminder._id });
        await scheduleNotificationsForReminders([updatedReminder]);
        setReminders((prev) => prev.map((r) => (r._id === editingReminder._id ? updatedReminder : r)));
        Alert.alert('Success', 'Reminder updated.');
      } else {
        for (const reminderDateTime of reminderDateTimes) {
          const body = JSON.stringify({
            medicationName: medicineName.trim(),
            time: reminderDateTime.toISOString(),
            repeating: repeat,
            timezone: tz,
            dosage: enteredDosage,
          });
          const response = await fetch(`${API_URL}/addMedication`, { method: 'POST', headers, body });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Failed to save.');
          savedCount += 1;
          const newReminder = new Reminder({
            _id: data.medicationId,
            medicationName: medicineName.trim(),
            dosage: enteredDosage,
            time: reminderDateTime.toISOString(),
            timezone: tz,
            repeating: repeat,
          });
          await scheduleNotificationsForReminders([newReminder]);
          setReminders((prev) => [...prev, newReminder]);
        }
        Alert.alert('Success', `${reminderDateTimes.length} ${reminderDateTimes.length === 1 ? 'reminder has' : 'reminders have'} been scheduled.`);
      }
      setIsFormVisible(false);
      setMedicineName('');
      setDosage('');
      setAiSchedule(null);
    } catch (error) {
      console.error('Error saving reminder:', error);
      if (aiTimes && savedCount > 0) {
        setAiSchedule((current) => current ? { ...current, times: current.times.slice(savedCount) } : current);
        Alert.alert('Some reminders were saved', `${savedCount} reminder(s) were saved. The remaining times are still in the form.`);
        return;
      }
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to save reminder.');
    }
  };

  const deleteReminder = async (reminder: Reminder) => {
    try {
      await cancelAllNotificationsForMedication(reminder);
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/medications/${reminder._id}`, { method: 'DELETE', headers });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
      setReminders((prev) => prev.filter((r) => r._id !== reminder._id));
      Alert.alert('Success', 'Reminder deleted.');
    } catch { Alert.alert('Error', 'Failed to delete reminder.'); }
  };

  const markAction = async (reminder: Reminder, action: 'taken' | 'skipped') => {
    const occurredAt = new Date().toISOString();
    const idempotencyKey = randomUUID();
    // Cancel only this dose's follow-up, including while the action is offline.
    await cancelEscalationForOccurrence(reminder._id, reminder.occurrenceId);
    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/medications/${reminder._id}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, idempotencyKey, occurredAt, occurrenceId: reminder.occurrenceId }),
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        await fetchReminders();
        Alert.alert(action === 'taken' ? '✅ Taken' : '⏭ Skipped', `${reminder.medicationName} marked as ${action}.`);
        // Flush any other offline-queued actions now that we know we have connectivity
        flushQueue().catch(() => {});
        return;
      }
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Server error ${response.status}`);
    } catch (e) {
      // Network unavailable or server error — queue for later retry
      const isNetworkError = e instanceof TypeError || (e instanceof Error && (e.message.includes('network') || e.message.includes('timeout') || e.name === 'TimeoutError' || e.name === 'AbortError'));
      if (isNetworkError || (e instanceof Error && e.message.includes('Server error 5'))) {
        await enqueueAction(reminder._id, action, reminder.occurrenceId, occurredAt);
        Alert.alert(
          action === 'taken' ? '✅ Saved offline' : '⏭ Saved offline',
          `${reminder.medicationName} marked ${action} and will sync when you're back online.`
        );
      } else {
        Alert.alert('Error', e instanceof Error ? e.message : 'Failed to record action.');
      }
    }
  };

  const loadDashboard = async () => {
    try {
      const headers = await authHeaders();
      const [adhRes, aiRes] = await Promise.allSettled([
        fetch(`${API_URL}/adherence`, { headers }),
        fetch(`${API_URL}/adherence/summary`, { headers }),
      ]);
      if (adhRes.status === 'fulfilled' && adhRes.value.ok) {
        const d = await adhRes.value.json();
        setAdherenceData(d.aggregated || []);
        setTotalTaken(d.totalTaken || 0);
        setTotalSkipped(d.totalSkipped || 0);
        setTotalUnconfirmed(d.totalUnconfirmed || 0);
        setTotalDoses(d.totalDoses || 0);
      } else {
        setAdherenceData([]);
        setTotalTaken(0);
        setTotalSkipped(0);
        setTotalUnconfirmed(0);
        setTotalDoses(0);
      }
      if (aiRes.status === 'fulfilled' && aiRes.value.ok) {
        const d = await aiRes.value.json();
        setAiSummary(d.success && d.summary ? d.summary : null);
      } else {
        setAiSummary(null);
      }
      setShowDashboard(true);
    } catch {
      Alert.alert('Error', 'Failed to load adherence dashboard. Check your connection.');
    }
  };

  // ── In-app banner ────────────────────────────────────────────────────────────
  const showBanner = () => {
    try {
      Vibration.vibrate([0, 150, 100, 180]);
    } catch {}
    Animated.spring(bannerAnimY, {
      toValue: 0,
      useNativeDriver: true,
      tension: 70,
      friction: 8,
    }).start();
  };

  const hideBanner = () => {
    Animated.timing(bannerAnimY, {
      toValue: -240,
      duration: 250,
      useNativeDriver: true,
    }).start(() => {
      setActiveBannerData(null);
    });
  };

  const handleBannerMarkTaken = async () => {
    try { Vibration.vibrate(80); } catch {}
    hideBanner();
    const medId = activeBannerData?.medicationId;
    if (medId) {
      const target = reminders.find((r) => r._id === medId) || new Reminder({
        _id: medId,
        medicationName: activeBannerData?.medicationName || 'Medication',
        time: new Date().toISOString(),
        repeating: false,
      });
      target.occurrenceId = activeBannerData?.occurrenceId ?? target.occurrenceId;
      await markAction(target, 'taken');
    }
  };

  const handleBannerSnooze = async () => {
    hideBanner();
    const medId = activeBannerData?.medicationId;
    const medName = activeBannerData?.medicationName || 'Medicine';
    if (Notifications && medId) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '⏰ Snoozed Reminder',
          body: `Reminder to take: ${medName}`,
          sound: 'default',
          priority: Notifications.AndroidNotificationPriority.HIGH,
          data: { medicationId: medId, medicationName: medName, type: 'reminder' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 600,
          channelId: 'medication-reminders',
        },
      }).catch(() => {});
    }
    Alert.alert('⏰ Snoozed', 'Reminder snoozed for 10 minutes.');
  };

  const handleSignOut = async () => {
    try {
      try { await (await getNativeGoogleSignIn())?.GoogleSignin.signOut(); } catch { /* not signed in with Google */ }
      await clearAuth();
      router.replace('/login');
    } catch { Alert.alert('Error', 'Failed to sign out.'); }
  };

  const onDateChange = (_: unknown, selectedDate?: Date) => {
    setShowDatePicker(false);
    if (!selectedDate) return;
    setDate(selectedDate);
    if (aiSchedule) return;
    setTimeout(() => setShowTimePicker(true), 250);
  };

  const onTimeChange = (_: unknown, selectedTime?: Date) => {
    setShowTimePicker(false);
    if (selectedTime && aiTimePickerIndex !== null) {
      const selectedClock = formatClock(selectedTime);
      setAiSchedule((current) => current && ({
        ...current,
        times: current.times.map((slot, index) => index === aiTimePickerIndex ? { ...slot, time: selectedClock } : slot),
      }));
    } else if (selectedTime) {
      setTime(selectedTime);
    }
    setAiTimePickerIndex(null);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#2A7BB5" barStyle="light-content" translucent />

      {/* ── In-app notification banner ── */}
      {activeBannerData && (
        <Animated.View style={[styles.headsUpBanner, { top: topInset + 8, transform: [{ translateY: bannerAnimY }] }]}>
          <View style={[styles.bannerCard, activeBannerData.type === 'escalation' && styles.bannerCardEscalation]}>
            <View style={styles.bannerHeader}>
              <View style={styles.bannerHeaderLeft}>
                <View style={[styles.bannerIconBadge, activeBannerData.type === 'escalation' && { backgroundColor: '#E67E22' }]}>
                  <MaterialCommunityIcons
                    name={activeBannerData.type === 'escalation' ? 'clock-alert' : 'bell-ring'}
                    size={15}
                    color="#fff"
                  />
                </View>
                <Text style={[styles.bannerAppTitle, activeBannerData.type === 'escalation' && { color: '#E67E22' }]}>
                  {activeBannerData.type === 'escalation' ? 'Reminder Follow-up' : 'PatientCareAI Medicine Reminder'}
                </Text>
              </View>
              <Text style={styles.bannerTimestamp}>Just now</Text>
            </View>
            <Text style={styles.bannerMedTitle}>{activeBannerData.medicationName}</Text>
            <Text style={styles.bannerMedDesc}>{activeBannerData.message}</Text>
            {activeBannerData.type === 'escalation' && (
              <Text style={styles.bannerEscalationNote}>
                This is a follow-up reminder on your device. Mark as taken or skipped to record your dose.
              </Text>
            )}
            <View style={styles.bannerActions}>
              <TouchableOpacity style={[styles.bannerBtn, styles.bannerBtnPrimary]} onPress={handleBannerMarkTaken}>
                <AntDesign name="check-circle" size={14} color="#fff" />
                <Text style={styles.bannerBtnTextPrimary}> Mark Taken</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.bannerBtn, styles.bannerBtnSecondary]} onPress={handleBannerSnooze}>
                <MaterialCommunityIcons name="clock-outline" size={15} color="#4A5568" />
                <Text style={styles.bannerBtnTextSecondary}> Snooze</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.bannerBtn, styles.bannerBtnDismiss]} onPress={hideBanner}>
                <Text style={styles.bannerBtnTextSecondary}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      )}

      {/* Header */}
      <View style={[styles.header, { paddingTop: topInset + 8 }]}>
        <TouchableOpacity onPress={() => setIsMenuVisible(true)}>
          <AntDesign name="menu-fold" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>PatientCareAI</Text>
        <TouchableOpacity onPress={() => setIsProfileMenuVisible(true)}>
          <AntDesign name="user" size={26} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Profile menu */}
      <Modal transparent visible={isProfileMenuVisible} animationType="fade" onRequestClose={() => setIsProfileMenuVisible(false)}>
        <TouchableOpacity style={[styles.modalOverlay, { paddingTop: topInset + 52 }]} activeOpacity={1} onPress={() => setIsProfileMenuVisible(false)}>
          <View style={styles.dropdownMenu}>
            <TouchableOpacity style={styles.menuItem} onPress={handleSignOut}>
              <AntDesign name="logout" size={16} color="#E53E3E" />
              <Text style={[styles.menuItemText, { color: '#E53E3E' }]}> Sign Out</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Hamburger menu */}
      <Modal transparent visible={isMenuVisible} animationType="fade" onRequestClose={() => setIsMenuVisible(false)}>
        <TouchableOpacity style={[styles.modalOverlay, { paddingTop: topInset + 52, alignItems: 'flex-start', paddingLeft: 16 }]} activeOpacity={1} onPress={() => setIsMenuVisible(false)}>
          <View style={styles.dropdownMenu}>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setIsMenuVisible(false); loadDashboard(); }}>
              <MaterialCommunityIcons name="chart-bar" size={18} color="#2A7BB5" />
              <Text style={styles.menuItemText}> Adherence Dashboard</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setIsMenuVisible(false); router.push('/caregiver' as any); }}>
              <MaterialCommunityIcons name="bell-alert-outline" size={18} color="#2A7BB5" />
              <Text style={styles.menuItemText}> Caregiver Alerts</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Create/Edit form modal */}
      <Modal transparent visible={isFormVisible} animationType="slide" onRequestClose={() => setIsFormVisible(false)}>
        <View style={styles.formOverlay}>
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>{editingReminder ? 'Edit Reminder' : 'New Reminder'}</Text>
            {!editingReminder && (
              <>
                <VoiceReminderInput
                  onTranscribed={(text) => setVoiceText(text)}
                />
                <ReminderLanguageInput
                  prefillText={voiceText}
                  onPrefillConsumed={() => setVoiceText('')}
                  onParsed={(parsed) => {
                    setMedicineName(parsed.medicationName);
                    setDosage(parsed.dosage ?? '');
                    setAiSchedule(parsed);
                  }}
                />
              </>
            )}
            {aiSchedule && (
              <View style={{ backgroundColor: '#F8FAFC', borderColor: '#D9E2EA', borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 14 }}>
                <Text style={{ color: '#1A365D', fontWeight: '700', marginBottom: 4 }}>Review AI extraction</Text>
                <Text style={{ color: '#536575', fontSize: 12, marginBottom: 8 }}>
                  {aiSchedule.frequency === 'daily' ? 'Repeats daily' : 'One-time reminder'} · verify this matches your schedule.
                </Text>
                {aiSchedule.times.map((slot, index) => (
                  <TouchableOpacity
                    key={`${slot.label}-${index}`}
                    onPress={() => {
                      setAiTimePickerIndex(index);
                      setShowTimePicker(true);
                    }}
                    style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 8, backgroundColor: '#fff', paddingHorizontal: 10, marginTop: 5 }}
                  >
                    <Text style={{ color: '#334155', fontSize: 13 }}>{slot.label}</Text>
                    <Text style={{ color: slot.time ? '#1769AA' : '#B42318', fontSize: 13, fontWeight: '700' }}>
                      {slot.time ? formatClockLabel(slot.time) : 'Choose time'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <TextInput
              style={styles.formInput}
              placeholder="Medicine name"
              placeholderTextColor="#aaa"
              value={medicineName}
              onChangeText={setMedicineName}
            />
            <TextInput
              style={styles.formInput}
              placeholder="Dosage (optional, as prescribed: e.g. 1 tablet, 5 ml)"
              placeholderTextColor="#aaa"
              value={dosage}
              onChangeText={setDosage}
              maxLength={80}
            />
            <TouchableOpacity style={styles.formPickerBtn} onPress={() => setShowDatePicker(true)}>
              <MaterialCommunityIcons name="calendar" size={18} color="#2A7BB5" />
              <Text style={styles.formPickerText}>
                {aiSchedule ? `${date.toLocaleDateString()} · start date` : `${date.toLocaleDateString()}  ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
              </Text>
            </TouchableOpacity>
            {showDatePicker && <DateTimePicker value={date} mode="date" display="default" onChange={onDateChange} />}
            {showTimePicker && (
              <DateTimePicker
                value={aiTimePickerIndex !== null && aiSchedule ? clockToDate(aiSchedule.times[aiTimePickerIndex]?.time ?? null) : time}
                mode="time"
                display="default"
                onChange={onTimeChange}
              />
            )}
            <View style={styles.formActions}>
              <TouchableOpacity style={[styles.formBtn, styles.cancelBtn]} onPress={() => setIsFormVisible(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.formBtn, styles.saveBtn]} onPress={promptRepeatAndSave}>
                <Text style={styles.saveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Dashboard modal */}
      <Modal transparent visible={showDashboard} animationType="slide" onRequestClose={() => setShowDashboard(false)}>
        <View style={styles.formOverlay}>
          <View style={[styles.formCard, { maxHeight: '85%' }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Text style={styles.formTitle}>Adherence (7 Days)</Text>
              <TouchableOpacity onPress={() => setShowDashboard(false)}>
                <AntDesign name="close" size={22} color="#555" />
              </TouchableOpacity>
            </View>
            <Text style={styles.adherenceSummaryText}>
              {totalDoses > 0
                ? `${totalTaken} taken · ${totalSkipped} skipped · ${totalUnconfirmed} unconfirmed (${totalDoses} expected)`
                : 'No dose history this week'}
            </Text>
            <Text style={styles.adherenceDisclaimer}>
              Counts reflect self-reported actions on expected doses. Unconfirmed means no action was recorded — it does not confirm a dose was missed. This is not a verified medical record.
            </Text>
            <ScrollView style={{ maxHeight: 260 }}>
              {adherenceData.length > 0 ? adherenceData.map((day) => {
                const total = day.taken + day.skipped + (day.unconfirmed || 0);
                const takenPct = total > 0 ? day.taken / total : 0;
                const skippedPct = total > 0 ? day.skipped / total : 0;
                const unconfPct = total > 0 ? (day.unconfirmed || 0) / total : 0;
                return (
                  <View key={day.date} style={styles.dayRow}>
                    <Text style={styles.dayLabel}>
                      {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </Text>
                    <View style={styles.barContainer}>
                      {takenPct > 0 && <View style={[styles.barFill, { flex: takenPct, backgroundColor: '#48BB78' }]} />}
                      {unconfPct > 0 && <View style={[styles.barFill, { flex: unconfPct, backgroundColor: '#ECC94B' }]} />}
                      {skippedPct > 0 && <View style={[styles.barFill, { flex: skippedPct, backgroundColor: '#FC8181' }]} />}
                      {total === 0 && <View style={[styles.barFill, { flex: 1, backgroundColor: '#E2E8F0' }]} />}
                    </View>
                    <Text style={styles.dayCount}>{day.taken}✓ {day.skipped}✗ {day.unconfirmed || 0}?</Text>
                  </View>
                );
              }) : (
                <View style={styles.emptyDashboard}>
                  <MaterialCommunityIcons name="chart-bar" size={36} color="#CBD5E0" />
                  <Text style={styles.emptyDashboardText}>
                    No dose actions this week. Mark doses as taken or skipped to see your activity here.
                  </Text>
                </View>
              )}
            </ScrollView>
            {aiSummary ? (
              <View style={styles.aiCard}>
                <Text style={styles.aiLabel}>AI Weekly Summary</Text>
                <Text style={styles.aiText}>{aiSummary}</Text>
                <Text style={styles.aiDisclaimer}>This summary is generated from your self-reported dose counts and does not constitute medical advice.</Text>
              </View>
            ) : (
              <Text style={styles.aiUnavailable}>AI summary not available</Text>
            )}
          </View>
        </View>
      </Modal>

      {/* Main content */}
      <ScrollView contentContainerStyle={styles.contentContainer}>

        {/* Notification permission status (honest, always visible if denied) */}
        {notifPermission === 'denied' && (
          <View style={styles.permissionWarning}>
            <MaterialCommunityIcons name="bell-off" size={18} color="#C05621" />
            <Text style={styles.permissionWarningText}>
              Notifications are disabled. Enable them in device Settings to receive medication reminders.
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.addButton} onPress={openCreateForm}>
          <AntDesign name="plus" size={20} color="#fff" />
          <Text style={styles.addButtonText}>Set Reminder</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>Your Medicines</Text>

        {loading && <Text style={styles.loadingText}>Loading reminders…</Text>}

        {!loading && reminders.length === 0 && (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="pill" size={48} color="#B2D8F0" />
            <Text style={styles.emptyText}>No reminders yet. Tap &quot;Set Reminder&quot; to add one.</Text>
          </View>
        )}

        {reminders.map((reminder) => (
          <View key={reminder._id} style={styles.reminderCard}>
            <View style={styles.reminderInfo}>
              <Text style={styles.reminderName}>{reminder.medicationName}</Text>
              <Text style={styles.reminderTime}>{reminder.getFormattedTime()}</Text>
              {reminder.repeating && (
                <View style={styles.repeatBadge}>
                  <MaterialCommunityIcons name="repeat" size={12} color="#2A7BB5" />
                  <Text style={styles.repeatBadgeText}> Daily</Text>
                </View>
              )}
            </View>
            <View style={styles.reminderActions}>
              <TouchableOpacity style={styles.actionBtn} onPress={() => markAction(reminder, 'taken')}>
                <AntDesign name="check" size={18} color="#48BB78" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={() => markAction(reminder, 'skipped')}>
                <AntDesign name="forward" size={18} color="#F6A623" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={() => openEditForm(reminder)}>
                <AntDesign name="edit" size={18} color="#2A7BB5" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionBtn} onPress={() => deleteReminder(reminder)}>
                <AntDesign name="delete" size={18} color="#E53E3E" />
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F0F6FC' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingBottom: 16, backgroundColor: '#2A7BB5',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#fff', letterSpacing: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 60, paddingRight: 16 },
  dropdownMenu: { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 6, minWidth: 200, elevation: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16 },
  menuItemText: { fontSize: 15, color: '#31363F', fontWeight: '500' },
  formOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  formCard: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36 },
  formTitle: { fontSize: 20, fontWeight: '700', color: '#1A365D', marginBottom: 16 },
  formInput: { height: 52, borderWidth: 1.5, borderColor: '#CBD5E0', borderRadius: 12, paddingHorizontal: 14, fontSize: 16, color: '#2D3748', backgroundColor: '#fff', marginBottom: 14 },
  formPickerBtn: { flexDirection: 'row', alignItems: 'center', height: 52, borderWidth: 1.5, borderColor: '#CBD5E0', borderRadius: 12, paddingHorizontal: 14, marginBottom: 20 },
  formPickerText: { fontSize: 15, color: '#4A5568', marginLeft: 8 },
  formActions: { flexDirection: 'row', gap: 12 },
  formBtn: { flex: 1, height: 50, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  cancelBtn: { backgroundColor: '#EDF2F7' },
  saveBtn: { backgroundColor: '#2A7BB5' },
  cancelBtnText: { fontSize: 16, color: '#4A5568', fontWeight: '600' },
  saveBtnText: { fontSize: 16, color: '#fff', fontWeight: '700' },
  contentContainer: { padding: 16, paddingBottom: 40 },
  permissionWarning: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFBEB',
    borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: '#FBD38D',
  },
  permissionWarningText: { fontSize: 13, color: '#744210', flex: 1, marginLeft: 8, lineHeight: 18 },
  addButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#2A7BB5', borderRadius: 14, paddingVertical: 14,
    marginBottom: 28, elevation: 3,
  },
  addButtonText: { color: '#fff', fontSize: 17, fontWeight: '700', marginLeft: 8 },
  sectionTitle: { fontSize: 22, fontWeight: '700', color: '#1A365D', marginBottom: 16 },
  loadingText: { textAlign: 'center', color: '#718096', marginTop: 30 },
  emptyState: { alignItems: 'center', marginTop: 60, paddingHorizontal: 30 },
  emptyText: { textAlign: 'center', color: '#718096', fontSize: 15, marginTop: 12, lineHeight: 22 },
  reminderCard: {
    backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    elevation: 2, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 6,
  },
  reminderInfo: { flex: 1 },
  reminderName: { fontSize: 16, fontWeight: '700', color: '#1A365D' },
  reminderTime: { fontSize: 13, color: '#718096', marginTop: 3 },
  repeatBadge: { flexDirection: 'row', alignItems: 'center', marginTop: 6, backgroundColor: '#EBF8FF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  repeatBadgeText: { fontSize: 11, color: '#2A7BB5', fontWeight: '600' },
  reminderActions: { flexDirection: 'row', gap: 6 },
  actionBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: '#F7FAFC', justifyContent: 'center', alignItems: 'center' },
  adherenceSummaryText: { fontSize: 16, fontWeight: '600', color: '#2D3748', marginBottom: 6, textAlign: 'center' },
  adherenceDisclaimer: { fontSize: 11, color: '#A0AEC0', textAlign: 'center', marginBottom: 14, lineHeight: 16 },
  dayRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  dayLabel: { width: 80, fontSize: 11, color: '#718096' },
  barContainer: { flex: 1, height: 12, flexDirection: 'row', borderRadius: 6, overflow: 'hidden', backgroundColor: '#E2E8F0', marginHorizontal: 8 },
  barFill: { height: '100%' },
  dayCount: { width: 50, fontSize: 11, color: '#4A5568', textAlign: 'right' },
  emptyDashboard: { alignItems: 'center', paddingVertical: 24 },
  emptyDashboardText: { color: '#718096', fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  aiCard: { backgroundColor: '#EBF8FF', borderRadius: 12, padding: 14, marginTop: 16 },
  aiLabel: { fontSize: 12, fontWeight: '700', color: '#2A7BB5', marginBottom: 6 },
  aiText: { fontSize: 14, color: '#2D3748', lineHeight: 20 },
  aiDisclaimer: { fontSize: 11, color: '#718096', marginTop: 8, lineHeight: 15 },
  aiUnavailable: { textAlign: 'center', color: '#A0AEC0', fontSize: 13, marginTop: 16 },

  // In-app notification banner
  headsUpBanner: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    zIndex: 9999,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  bannerCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 15,
    borderWidth: 1.5,
    borderColor: '#90CDF4',
    elevation: 8,
  },
  bannerCardEscalation: {
    borderColor: '#F6AD55',
    backgroundColor: '#FFFAF0',
  },
  bannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  bannerHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bannerIconBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#2A7BB5',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  bannerAppTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2A7BB5',
  },
  bannerTimestamp: {
    fontSize: 11,
    color: '#A0AEC0',
    fontWeight: '500',
  },
  bannerMedTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1A202C',
    marginBottom: 3,
  },
  bannerMedDesc: {
    fontSize: 12,
    color: '#4A5568',
    lineHeight: 17,
    marginBottom: 6,
  },
  bannerEscalationNote: {
    fontSize: 11,
    color: '#744210',
    lineHeight: 16,
    marginBottom: 8,
    backgroundColor: '#FEFCBF',
    borderRadius: 6,
    padding: 6,
  },
  bannerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  bannerBtn: {
    flex: 1,
    height: 38,
    borderRadius: 10,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bannerBtnPrimary: {
    backgroundColor: '#48BB78',
  },
  bannerBtnSecondary: {
    backgroundColor: '#EDF2F7',
  },
  bannerBtnDismiss: {
    backgroundColor: '#EDF2F7',
    flex: 0.7,
  },
  bannerBtnTextPrimary: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  bannerBtnTextSecondary: {
    color: '#4A5568',
    fontWeight: '600',
    fontSize: 12,
  },
});

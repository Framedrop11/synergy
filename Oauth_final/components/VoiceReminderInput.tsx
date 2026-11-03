/**
 * VoiceReminderInput.tsx — Voice input for reminder drafting.
 *
 * Uses the operating system's speech-recognition service (no PatientCareAI audio upload).
 * Supports English (en-US) and Hindi (hi-IN).
 * The transcribed text is passed to the same /reminders/parse endpoint as typed input.
 *
 * Limitations (displayed honestly in the UI):
 * - Requires RECORD_AUDIO permission (Android) or microphone usage description (iOS).
 * - Speech recognition is only available on devices with the OS speech service.
 *   It is not available in Expo Go — a dev build is required.
 * - The operating system or selected recognition provider may process speech online.
 * - Transcription accuracy varies. The patient must review the draft before saving.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ParsedReminderDraft } from '@/utils/reminderAssistant';

// Graceful degradation: expo-speech-recognition requires a dev build.
let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native module is optional in Expo Go.
  const mod = require('expo-speech-recognition');
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
} catch {
  // Not available (Expo Go or unsupported platform)
}

type SpeechLang = 'en-US' | 'hi-IN';

const LANG_LABEL: Record<SpeechLang, string> = {
  'en-US': 'EN',
  'hi-IN': 'हिं',
};

interface Props {
  onTranscribed: (text: string) => void;
  onParsed?: (draft: ParsedReminderDraft) => void;
  onError?: (message: string) => void;
}

export default function VoiceReminderInput({ onTranscribed, onError }: Props) {
  const [available, setAvailable] = useState<boolean | null>(ExpoSpeechRecognitionModule ? null : false); // null = checking
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [lang, setLang] = useState<SpeechLang>('en-US');
  const [error, setError] = useState('');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const transcriptRef = useRef('');

  // Check availability once on mount
  useEffect(() => {
    if (!ExpoSpeechRecognitionModule) {
      return;
    }
    const checkAvailability = (ExpoSpeechRecognitionModule as any).isRecognitionAvailable;
    const checkOnMount = async () => {
      // Defer the state update until after the effect has yielded.
      await Promise.resolve();
      try {
        // expo-speech-recognition exposes this as a synchronous boolean.
        // Older native builds may not include it, so degrade voice input safely.
        if (typeof checkAvailability !== 'function') {
          setAvailable(false);
          return;
        }
        setAvailable(Boolean(checkAvailability.call(ExpoSpeechRecognitionModule)));
      } catch {
        setAvailable(false);
      }
    };
    void checkOnMount();
  }, []);

  // Wire up speech recognition events
  if (useSpeechRecognitionEvent) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useSpeechRecognitionEvent('result', (event: any) => {
      const text = event.results?.[0]?.transcript || '';
      setTranscript(text);
      transcriptRef.current = text;
    });

    // eslint-disable-next-line react-hooks/rules-of-hooks
    useSpeechRecognitionEvent('end', () => {
      setListening(false);
      const final = transcriptRef.current.trim();
      if (final) {
        onTranscribed(final);
        setTranscript('');
        transcriptRef.current = '';
      }
    });

    // eslint-disable-next-line react-hooks/rules-of-hooks
    useSpeechRecognitionEvent('error', (event: any) => {
      setListening(false);
      const msg = event.message || 'Speech recognition error. Please try again.';
      if (event.error === 'not-allowed') setPermissionDenied(true);
      setError(msg);
      if (onError) onError(msg);
    });
  }

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!ExpoSpeechRecognitionModule || typeof ExpoSpeechRecognitionModule.requestPermissionsAsync !== 'function') return false;
    try {
      const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      return Boolean(result?.granted);
    } catch {
      return false;
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!ExpoSpeechRecognitionModule || typeof ExpoSpeechRecognitionModule.start !== 'function' || !available) return;

    setError('');
    setPermissionDenied(false);
    const granted = await requestPermission();
    if (!granted) {
      const msg = 'Microphone permission is required for voice input. Enable it in device Settings.';
      setPermissionDenied(true);
      setError(msg);
      if (onError) onError(msg);
      return;
    }

    setTranscript('');
    transcriptRef.current = '';

    try {
      await ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true,
        maxAlternatives: 1,
        // Continuous mode so the patient can speak a full sentence
        continuous: false,
      });
      setListening(true);
    } catch (e: any) {
      const msg = e?.message || 'Could not start voice recognition.';
      if (e?.error === 'not-allowed') setPermissionDenied(true);
      setError(msg);
      if (onError) onError(msg);
    }
  }, [available, lang, onError, requestPermission]);

  const stopListening = useCallback(async () => {
    if (!ExpoSpeechRecognitionModule || typeof ExpoSpeechRecognitionModule.stop !== 'function') return;
    try {
      await ExpoSpeechRecognitionModule.stop();
    } catch {}
    setListening(false);
  }, []);

  // Not available in Expo Go or unsupported device
  if (available === false) {
    return (
      <View style={styles.unavailableCard}>
        <Text style={styles.unavailableText}>
          🎤 Voice input is not available in this environment.{' '}
          {Platform.OS !== 'android' && Platform.OS !== 'ios'
            ? 'It is only supported on Android and iOS.'
            : 'A development build is required — it does not work in Expo Go.'}
        </Text>
      </View>
    );
  }

  // Checking availability
  if (available === null) return null;

  return (
    <View style={styles.card}>
      {/* Language picker */}
      <View style={styles.langRow}>
        {(Object.keys(LANG_LABEL) as SpeechLang[]).map((l) => (
          <TouchableOpacity
            key={l}
            style={[styles.langBtn, lang === l && styles.langBtnActive]}
            onPress={() => setLang(l)}
            disabled={listening}
          >
            <Text style={[styles.langBtnText, lang === l && styles.langBtnTextActive]}>
              {LANG_LABEL[l]}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.cardTitle}>Voice input</Text>
      </View>

      <Text style={styles.helpText}>
        Tap the microphone and describe your medication and schedule. Your device&apos;s speech service creates the transcript; depending on your device settings, speech recognition may use online processing. PatientCareAI receives and stores no audio recording.
      </Text>

      {/* Transcript preview */}
      {(listening || transcript) ? (
        <View style={styles.transcriptBox}>
          {listening && (
            <View style={styles.listeningRow}>
              <ActivityIndicator size="small" color="#E53E3E" />
              <Text style={styles.listeningLabel}>Listening…</Text>
            </View>
          )}
          {transcript ? (
            <Text style={styles.transcriptText}>{transcript}</Text>
          ) : null}
        </View>
      ) : null}

      {/* Mic button */}
      <TouchableOpacity
        style={[styles.micBtn, listening && styles.micBtnActive]}
        onPress={listening ? stopListening : startListening}
        accessibilityLabel={listening ? 'Stop recording' : 'Start voice input'}
        accessibilityRole="button"
      >
        <Text style={styles.micIcon}>{listening ? '⏹' : '🎤'}</Text>
        <Text style={styles.micLabel}>{listening ? 'Tap to stop' : 'Tap to speak'}</Text>
      </TouchableOpacity>

      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>
      ) : null}
      {permissionDenied && (
        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => { void Linking.openSettings().catch(() => setError('Could not open Settings. Open PatientCareAI app permissions manually from device Settings.')); }}
          accessibilityRole="button"
        >
          <Text style={styles.settingsBtnText}>Open app Settings</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.disclaimer}>
        Voice transcription may not be 100% accurate. Review the result carefully before saving.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFF5F5',
    borderWidth: 1,
    borderColor: '#FEB2B2',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  langBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FEB2B2',
    backgroundColor: '#fff',
  },
  langBtnActive: {
    backgroundColor: '#E53E3E',
    borderColor: '#E53E3E',
  },
  langBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#C53030',
  },
  langBtnTextActive: {
    color: '#fff',
  },
  cardTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#742A2A',
  },
  helpText: {
    fontSize: 12,
    color: '#744210',
    lineHeight: 17,
    marginBottom: 10,
  },
  transcriptBox: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#FEB2B2',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    minHeight: 48,
  },
  listeningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  listeningLabel: {
    fontSize: 12,
    color: '#E53E3E',
    fontWeight: '600',
  },
  transcriptText: {
    fontSize: 14,
    color: '#2D3748',
    lineHeight: 20,
  },
  micBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: 12,
    backgroundColor: '#E53E3E',
    gap: 10,
    marginBottom: 8,
  },
  micBtnActive: {
    backgroundColor: '#9B2C2C',
  },
  micIcon: {
    fontSize: 20,
  },
  micLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  errorText: {
    color: '#C53030',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 6,
  },
  settingsBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 6,
    borderRadius: 8,
    backgroundColor: '#FEE2E2',
  },
  settingsBtnText: { color: '#9B2C2C', fontSize: 12, fontWeight: '700' },
  disclaimer: {
    fontSize: 11,
    color: '#A0AEC0',
    lineHeight: 15,
    fontStyle: 'italic',
  },
  unavailableCard: {
    backgroundColor: '#F7FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  unavailableText: {
    fontSize: 12,
    color: '#718096',
    lineHeight: 17,
  },
});

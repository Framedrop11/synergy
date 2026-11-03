/**
 * ReminderLanguageInput — conversational AI reminder drafting component.
 *
 * Supports:
 *   - Multi-turn conversation: the AI can ask follow-up questions
 *   - Language toggle: English and Hindi
 *   - Dosage display: shown when the patient explicitly states it; never inferred
 *   - Patient confirms the final draft before it is passed to the parent for saving
 *
 * The conversation history is kept client-side and sent to POST /reminders/parse
 * as the `history` array on each turn. It is discarded when the component unmounts
 * or when the patient resets.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { authHeaders } from '@/utils/authStorage';
import {
  ConversationTurn,
  isParsedReminderDraft,
  ParsedReminderDraft,
} from '@/utils/reminderAssistant';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

type Language = 'en' | 'hi';

const UI_STRINGS: Record<Language, {
  title: string;
  help: string;
  placeholder: string;
  sendBtn: string;
  resetBtn: string;
  draftReady: string;
  dosageLabel: string;
  dosageNote: string;
  confirmBtn: string;
  editBtn: string;
  you: string;
  assistant: string;
}> = {
  en: {
    title: 'Describe the reminder',
    help: 'Tell me the medicine name and schedule (e.g. "Metformin 500 mg twice daily"). I may ask a follow-up question.',
    placeholder: 'Type your message…',
    sendBtn: 'Send',
    resetBtn: 'Start over',
    draftReady: 'Draft ready — review before saving',
    dosageLabel: 'Dosage you stated',
    dosageNote: 'This is what you said — not a prescription. Verify with your doctor.',
    confirmBtn: 'Use this draft',
    editBtn: 'Edit',
    you: 'You',
    assistant: 'PatientCareAI Assistant',
  },
  hi: {
    title: 'रिमाइंडर बताएं',
    help: 'दवाई का नाम और समय बताएं (जैसे "मेटफ़ॉर्मिन 500 mg सुबह-शाम"). मैं कुछ और जानकारी मांग सकता हूँ।',
    placeholder: 'अपना संदेश टाइप करें…',
    sendBtn: 'भेजें',
    resetBtn: 'फिर से शुरू करें',
    draftReady: 'ड्राफ़्ट तैयार है — सहेजने से पहले जाँचें',
    dosageLabel: 'आपने बताई खुराक',
    dosageNote: 'यह आपकी बात है — यह प्रिस्क्रिप्शन नहीं है। डॉक्टर से पुष्टि करें।',
    confirmBtn: 'इस ड्राफ़्ट का उपयोग करें',
    editBtn: 'बदलें',
    you: 'आप',
    assistant: 'PatientCareAI सहायक',
  },
};

interface Props {
  onParsed: (draft: ParsedReminderDraft) => void;
  /** When set, this text is placed into the input field (e.g. from voice transcription). */
  prefillText?: string;
  /** Called after prefillText has been consumed so the parent can clear it. */
  onPrefillConsumed?: () => void;
}

interface DisplayMessage {
  role: 'user' | 'assistant';
  text: string;
}

export default function ReminderLanguageInput({ onParsed, prefillText, onPrefillConsumed }: Props) {
  const [lang, setLang] = useState<Language>('en');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [display, setDisplay] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState<ParsedReminderDraft | null>(null);

  // Auto-populate input when a voice transcript arrives
  React.useEffect(() => {
    if (prefillText && prefillText.trim().length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs the external speech transcript prop into the input.
      setInput(prefillText.trim());
      setError('');
      if (onPrefillConsumed) onPrefillConsumed();
    }
  }, [prefillText, onPrefillConsumed]);

  const s = UI_STRINGS[lang];

  const reset = () => {
    setInput('');
    setError('');
    setHistory([]);
    setDisplay([]);
    setDraft(null);
    setLoading(false);
  };

  const send = async () => {
    const text = input.trim();
    if (text.length < 2) {
      setError(lang === 'en' ? 'Please type a message first.' : 'पहले कुछ लिखें।');
      return;
    }
    if (!API_URL) {
      setError(lang === 'en'
        ? 'AI is unavailable. Enter the reminder manually below.'
        : 'AI उपलब्ध नहीं है। नीचे मैन्युअल रूप से दर्ज करें।');
      return;
    }

    setLoading(true);
    setError('');
    setInput('');

    const userMsg: ConversationTurn = { role: 'user', content: text };
    const newHistory = [...history, userMsg];
    setDisplay((prev) => [...prev, { role: 'user', text }]);

    try {
      const headers = await authHeaders();
      const response = await fetch(`${API_URL}/reminders/parse`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, history, language: lang }),
        signal: AbortSignal.timeout(20000),
      });

      const responseText = await response.text();
      let payload: any;
      try {
        payload = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(lang === 'en'
          ? `The reminder service returned an unexpected response (${response.status}).`
          : `सेवा ने अप्रत्याशित उत्तर दिया (${response.status})।`);
      }

      if (!response.ok) {
        throw new Error(payload.message || (lang === 'en'
          ? 'AI could not parse that. Please try again.'
          : 'AI समझ नहीं पाया। पुनः प्रयास करें।'));
      }

      // Clarification needed — show the AI's question
      if (payload.clarificationNeeded && payload.clarificationPrompt) {
        const assistantMsg: ConversationTurn = {
          role: 'assistant',
          content: payload.clarificationPrompt,
        };
        setHistory([...newHistory, assistantMsg]);
        setDisplay((prev) => [...prev, { role: 'assistant', text: payload.clarificationPrompt }]);
        return;
      }

      // Draft ready — validate and surface it
      if (!isParsedReminderDraft(payload)) {
        throw new Error(lang === 'en'
          ? 'AI returned an incomplete schedule. Please try again or enter manually.'
          : 'AI ने अधूरा शेड्यूल दिया। पुनः प्रयास करें या मैन्युअल दर्ज करें।');
      }

      setHistory(newHistory);
      setDraft(payload);

      const summary =
        `${payload.medicationName}` +
        (payload.dosage ? ` · ${payload.dosage}` : '') +
        ` · ${payload.frequency === 'daily' ? (lang === 'en' ? 'Daily' : 'प्रतिदिन') : (lang === 'en' ? 'One-time' : 'एकबार')}`;
      setDisplay((prev) => [...prev, { role: 'assistant', text: summary }]);
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : (lang === 'en' ? 'Something went wrong. Try again.' : 'कुछ गलत हुआ। पुनः प्रयास करें।');
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const confirmDraft = () => {
    if (draft) {
      onParsed(draft);
      reset();
    }
  };

  return (
    <View style={styles.card}>
      {/* Language toggle */}
      <View style={styles.langRow}>
        <TouchableOpacity
          style={[styles.langBtn, lang === 'en' && styles.langBtnActive]}
          onPress={() => setLang('en')}
        >
          <Text style={[styles.langBtnText, lang === 'en' && styles.langBtnTextActive]}>EN</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.langBtn, lang === 'hi' && styles.langBtnActive]}
          onPress={() => setLang('hi')}
        >
          <Text style={[styles.langBtnText, lang === 'hi' && styles.langBtnTextActive]}>हिं</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{s.title}</Text>
      </View>

      {display.length === 0 && (
        <Text style={styles.help}>{s.help}</Text>
      )}

      {/* Conversation history */}
      {display.length > 0 && (
        <ScrollView style={styles.historyBox} nestedScrollEnabled>
          {display.map((msg, i) => (
            <View
              key={i}
              style={[styles.bubble, msg.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}
            >
              <Text style={styles.bubbleRole}>
                {msg.role === 'user' ? s.you : s.assistant}
              </Text>
              <Text style={styles.bubbleText}>{msg.text}</Text>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Draft ready panel */}
      {draft && (
        <View style={styles.draftPanel}>
          <Text style={styles.draftReady}>{s.draftReady}</Text>
          <Text style={styles.draftName}>{draft.medicationName}</Text>
          {draft.dosage && (
            <View style={styles.dosageBox}>
              <Text style={styles.dosageLabel}>{s.dosageLabel}: </Text>
              <Text style={styles.dosageValue}>{draft.dosage}</Text>
            </View>
          )}
          {draft.dosage && (
            <Text style={styles.dosageNote}>{s.dosageNote}</Text>
          )}
          <View style={styles.draftActions}>
            <TouchableOpacity style={[styles.draftBtn, styles.draftBtnPrimary]} onPress={confirmDraft}>
              <Text style={styles.draftBtnPrimaryText}>{s.confirmBtn}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.draftBtn, styles.draftBtnSecondary]} onPress={reset}>
              <Text style={styles.draftBtnSecondaryText}>{s.editBtn}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Input row — hidden once draft is ready */}
      {!draft && (
        <View style={styles.inputRow}>
          <TextInput
            accessibilityLabel={lang === 'en'
              ? 'Describe medication and reminder schedule'
              : 'दवाई और शेड्यूल बताएं'}
            style={styles.input}
            value={input}
            onChangeText={(v) => { setInput(v); setError(''); }}
            placeholder={s.placeholder}
            placeholderTextColor="#8795A1"
            multiline={false}
            maxLength={500}
            editable={!loading}
            returnKeyType="send"
            onSubmitEditing={send}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (loading || input.trim().length < 2) && styles.sendBtnDisabled]}
            onPress={send}
            disabled={loading || input.trim().length < 2}
            accessibilityLabel={s.sendBtn}
          >
            {loading
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.sendBtnText}>{s.sendBtn}</Text>
            }
          </TouchableOpacity>
        </View>
      )}

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
      ) : null}

      {(display.length > 0 || draft) && (
        <TouchableOpacity onPress={reset} style={styles.resetBtn}>
          <Text style={styles.resetBtnText}>{s.resetBtn}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#F1F8FD',
    borderWidth: 1,
    borderColor: '#C8DFEF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 6,
  },
  langBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C8DFEF',
    backgroundColor: '#fff',
  },
  langBtnActive: {
    backgroundColor: '#2A7BB5',
    borderColor: '#2A7BB5',
  },
  langBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4A5568',
  },
  langBtnTextActive: {
    color: '#fff',
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1A365D',
    flex: 1,
  },
  help: {
    fontSize: 12,
    lineHeight: 17,
    color: '#536575',
    marginBottom: 10,
  },
  historyBox: {
    maxHeight: 160,
    marginBottom: 10,
  },
  bubble: {
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
  },
  bubbleUser: {
    backgroundColor: '#DBEAFE',
    alignSelf: 'flex-end',
    maxWidth: '88%',
  },
  bubbleAssistant: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#D1E8F5',
    alignSelf: 'flex-start',
    maxWidth: '88%',
  },
  bubbleRole: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    marginBottom: 2,
  },
  bubbleText: {
    fontSize: 13,
    color: '#1E293B',
    lineHeight: 18,
  },
  draftPanel: {
    backgroundColor: '#F0FFF4',
    borderWidth: 1,
    borderColor: '#9AE6B4',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  draftReady: {
    fontSize: 11,
    fontWeight: '700',
    color: '#276749',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  draftName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1A365D',
    marginBottom: 6,
  },
  dosageBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  dosageLabel: {
    fontSize: 12,
    color: '#4A5568',
    fontWeight: '600',
  },
  dosageValue: {
    fontSize: 12,
    color: '#276749',
    fontWeight: '700',
  },
  dosageNote: {
    fontSize: 11,
    color: '#718096',
    fontStyle: 'italic',
    lineHeight: 15,
    marginBottom: 8,
  },
  draftActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  draftBtn: {
    flex: 1,
    height: 38,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  draftBtnPrimary: {
    backgroundColor: '#2A7BB5',
  },
  draftBtnSecondary: {
    backgroundColor: '#EDF2F7',
    borderWidth: 1,
    borderColor: '#CBD5E0',
  },
  draftBtnPrimaryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  draftBtnSecondaryText: {
    color: '#4A5568',
    fontSize: 13,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: '#BDD0DE',
    borderRadius: 10,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#263746',
  },
  sendBtn: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#2A7BB5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.55,
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  error: {
    color: '#B42318',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
  },
  resetBtn: {
    alignSelf: 'center',
    marginTop: 8,
    paddingVertical: 4,
  },
  resetBtnText: {
    fontSize: 12,
    color: '#718096',
    textDecorationLine: 'underline',
  },
});

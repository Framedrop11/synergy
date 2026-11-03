/**
 * reminderAssistant.ts — type definitions and validation for AI-parsed reminder drafts.
 *
 * The backend returns a ParsedReminderDraft when it successfully extracts a
 * reminder schedule from natural-language input. The patient must review and
 * confirm the draft before it is saved.
 */

export type ParsedReminderFrequency = 'daily' | 'once';

export interface ParsedReminderTime {
  /** Human-readable label such as "Morning", "Before bed", "Dinner" */
  label: string;
  /** Clock time in HH:mm 24-hour format, or null when the AI could not determine it */
  time: string | null;
}

export interface ParsedReminderDraft {
  /** Medication name exactly as stated by the patient */
  medicationName: string;
  /**
   * Dosage as explicitly stated by the patient (e.g. "1 tablet", "5 ml").
   * null when the patient did not state a dosage. Never inferred by the AI.
   */
  dosage: string | null;
  frequency: ParsedReminderFrequency;
  times: ParsedReminderTime[];
  /** True when the AI needs more information from the patient before a draft can be completed. */
  clarificationNeeded: boolean;
  /** Question to ask the patient when clarificationNeeded is true. */
  clarificationPrompt: string | null;
}

/** One message in the conversational history sent to the backend. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const isParsedReminderDraft = (value: unknown): value is ParsedReminderDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ParsedReminderDraft>;
  return (
    typeof draft.medicationName === 'string' &&
    (draft.frequency === 'daily' || draft.frequency === 'once') &&
    Array.isArray(draft.times) &&
    draft.times.length > 0 &&
    draft.times.length <= 4 &&
    draft.times.every(
      (item) =>
        item &&
        typeof item.label === 'string' &&
        (item.time === null ||
          (typeof item.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)))
    )
  );
};

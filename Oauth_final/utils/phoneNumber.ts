const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const ALLOWED_FORMATTING = /^[+\d\s().-]+$/;

/** Normalize Indian local mobile input or a formatted international number to E.164. */
export function normalizeCaregiverPhone(value: string): string | null {
  const raw = value.trim();
  const plusCount = (raw.match(/\+/g) || []).length;
  if (!raw || !ALLOWED_FORMATTING.test(raw) || plusCount > 1 || (plusCount === 1 && !raw.startsWith('+'))) return null;

  const digits = raw.replace(/\D/g, '');
  let normalized: string;

  if (raw.startsWith('+')) {
    normalized = `+${digits}`;
  } else if (/^[6-9]\d{9}$/.test(digits)) {
    normalized = `+91${digits}`;
  } else if (/^0[6-9]\d{9}$/.test(digits)) {
    normalized = `+91${digits.slice(1)}`;
  } else if (/^91[6-9]\d{9}$/.test(digits)) {
    normalized = `+${digits}`;
  } else {
    return null;
  }

  return E164_PATTERN.test(normalized) ? normalized : null;
}

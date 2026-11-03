const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const ALLOWED_FORMATTING = /^[+\d\s().-]+$/;

/**
 * Convert common phone-number input to E.164.
 * Ten-digit Indian mobile numbers use +91; other numbers must include +country code.
 */
function normalizeCaregiverPhone(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const plusCount = (raw.match(/\+/g) || []).length;
  if (!raw || !ALLOWED_FORMATTING.test(raw) || plusCount > 1 || (plusCount === 1 && !raw.startsWith("+"))) return null;

  const digits = raw.replace(/\D/g, "");
  let normalized;

  if (raw.startsWith("+")) {
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

module.exports = { normalizeCaregiverPhone };

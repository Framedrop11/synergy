const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCaregiverPhone } = require("../phoneNumber");

test("normalizes common Indian mobile input to E.164", () => {
  assert.equal(normalizeCaregiverPhone("9876543210"), "+919876543210");
  assert.equal(normalizeCaregiverPhone("09876543210"), "+919876543210");
  assert.equal(normalizeCaregiverPhone("91 98765-43210"), "+919876543210");
  assert.equal(normalizeCaregiverPhone("+91 (98765) 43210"), "+919876543210");
});

test("normalizes formatted international E.164 input", () => {
  assert.equal(normalizeCaregiverPhone("+1 (415) 555-2671"), "+14155552671");
});

test("rejects malformed, ambiguous, and too-long numbers", () => {
  assert.equal(normalizeCaregiverPhone("12345"), null);
  assert.equal(normalizeCaregiverPhone("+91-abc-9876543210"), null);
  assert.equal(normalizeCaregiverPhone("+1234567890123456"), null);
  assert.equal(normalizeCaregiverPhone("+91+9876543210"), null);
});

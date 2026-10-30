const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addLocalDays,
  buildOccurrenceDates,
  localClockString,
  localDateString,
  localDateTimeToUtc,
} = require("../scheduleTime");

test("daily occurrences follow the saved IANA timezone across UTC dates", () => {
  const now = new Date("2026-10-30T00:00:00.000Z");
  const schedule = new Date("2026-10-30T02:30:00.000Z"); // 08:00 Asia/Kolkata
  const results = buildOccurrenceDates({ time: schedule, timezone: "Asia/Kolkata", repeating: true }, now, 3);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((date) => localClockString(date, "Asia/Kolkata")), ["08:00", "08:00", "08:00"]);
  assert.deepEqual(results.map((date) => localDateString(date, "Asia/Kolkata")), ["2026-10-30", "2026-10-31", "2026-11-01"]);
});

test("local calendar arithmetic handles month and year boundaries", () => {
  assert.equal(addLocalDays("2026-12-31", 1), "2027-01-01");
});

test("invalid IANA zones are rejected and spring-forward gaps move to the first valid time", () => {
  assert.throws(() => buildOccurrenceDates({ time: new Date(), timezone: "Not/AZone", repeating: true }));
  const shifted = localDateTimeToUtc("2026-03-08", "02:30", "America/New_York");
  assert.equal(shifted.toISOString(), "2026-03-08T07:00:00.000Z"); // 03:00 local, first valid minute
});

test("one-time reminders produce only their future occurrence", () => {
  const now = new Date("2026-10-30T00:00:00.000Z");
  assert.equal(buildOccurrenceDates({ time: new Date("2026-10-30T01:00:00.000Z"), repeating: false }, now).length, 1);
  assert.equal(buildOccurrenceDates({ time: new Date("2026-10-29T23:00:00.000Z"), repeating: false }, now).length, 0);
});

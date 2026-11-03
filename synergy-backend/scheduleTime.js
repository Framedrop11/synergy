const DATE_FORMATTER_CACHE = new Map();

function getFormatter(timezone) {
  if (!DATE_FORMATTER_CACHE.has(timezone)) {
    DATE_FORMATTER_CACHE.set(timezone, new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }));
  }
  return DATE_FORMATTER_CACHE.get(timezone);
}

function zonedParts(date, timezone) {
  const values = Object.fromEntries(getFormatter(timezone).formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function localDateString(date, timezone) {
  const p = zonedParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function localClockString(date, timezone) {
  const p = zonedParts(date, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function addLocalDays(dateString, amount) {
  const [year, month, day] = dateString.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + amount));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Convert a local wall-clock date and time to UTC in an IANA timezone.
 * A nonexistent spring-forward time moves to the first valid minute that day.
 * For repeated fall-back times, the iterative conversion chooses one matching instant.
 */
function localDateTimeToUtc(dateString, clockString, timezone) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute] = clockString.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite) || hour > 23 || minute > 59) {
    throw new Error("Invalid local date or time");
  }

  const target = Date.UTC(year, month - 1, day, hour, minute);
  const exactConversion = (localTarget) => {
    let candidate = localTarget;
    for (let i = 0; i < 6; i++) {
      const p = zonedParts(new Date(candidate), timezone);
      const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
      const delta = localTarget - represented;
      if (delta === 0) return new Date(candidate);
      candidate += delta;
    }
    const p = zonedParts(new Date(candidate), timezone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return represented === localTarget ? new Date(candidate) : null;
  };

  const exact = exactConversion(target);
  if (exact) return exact;

  // Spring-forward gap: shift the dose to the first valid local minute after the gap.
  for (let offset = 1; offset <= 180; offset++) {
    const shifted = exactConversion(target + offset * 60_000);
    if (shifted) return shifted;
  }
  return null;
}

function buildOccurrenceDates(medication, now = new Date(), horizonDays = 7) {
  const timezone = medication.timezone || "UTC";
  // Validate timezone before creating any occurrence documents.
  getFormatter(timezone).format(now);
  const initialTime = new Date(medication.time);
  if (Number.isNaN(initialTime.getTime())) throw new Error("Invalid reminder time");

  if (!medication.repeating) return initialTime > now ? [initialTime] : [];

  const clock = localClockString(initialTime, timezone);
  const today = localDateString(now, timezone);
  const firstConfiguredDay = localDateString(initialTime, timezone);
  const startDate = firstConfiguredDay > today ? firstConfiguredDay : today;
  const results = [];

  for (let i = 0; i < horizonDays; i++) {
    const localDate = addLocalDays(startDate, i);
    const due = localDateTimeToUtc(localDate, clock, timezone);
    if (due && due > now) results.push(due);
  }
  return results;
}

module.exports = {
  addLocalDays,
  buildOccurrenceDates,
  localClockString,
  localDateString,
  localDateTimeToUtc,
  zonedParts,
};

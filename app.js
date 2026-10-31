require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const https = require("https");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");

const User = require("./UserDetails");
const Medication = require("./MedicationDetails");
const ActivityLog = require("./ActivityLog");
const Occurrence = require("./Occurrence");
const AlertLog = require("./AlertLog");
const { buildOccurrenceDates, localDateString, addLocalDays, localClockString, localDateTimeToUtc } = require("./scheduleTime");
const { sendEmail, sendSms, isChannelConfigured } = require("./notificationProviders");
const MongoRateLimitStore = require("./MongoRateLimitStore");
const { normalizeCaregiverPhone } = require("./phoneNumber");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ─── Startup guards ──────────────────────────────────────────────────────────
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    "FATAL: JWT_SECRET is missing or too short. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
  );
  process.exit(1);
}

if (!MONGO_URI) {
  console.error("FATAL: MONGO_URI is required.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && process.env.APP_BASE_URL && !process.env.APP_BASE_URL.startsWith("https://")) {
  console.error("FATAL: APP_BASE_URL must use HTTPS in production.");
  process.exit(1);
}

if (!GOOGLE_WEB_CLIENT_ID) {
  console.warn("GOOGLE_WEB_CLIENT_ID is not set. Google sign-in is disabled.");
}

const googleClient = new OAuth2Client();

// ─── CORS & JSON ─────────────────────────────────────────────────────────────
const corsOrigins = (process.env.CORS_ORIGIN || "*").split(",").map((origin) => origin.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production" && (corsOrigins.length === 0 || corsOrigins.includes("*"))) {
  console.error("FATAL: set CORS_ORIGIN to the exact production frontend origin(s), comma-separated.");
  process.exit(1);
}
app.use(
  cors({
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? "ok" : "degraded",
    db: dbState === 1 ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

// ─── DATABASE ─────────────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Database connected"))
  .catch((err) => {
    console.error("Error connecting to database:", err);
    process.exit(1);
  });

// ─── RATE LIMITERS ────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new MongoRateLimitStore("login"),
});

const reminderParseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "AI parsing is temporarily rate limited. Please enter the reminder manually." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new MongoRateLimitStore("reminder-parse"),
});
const caregiverVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many verification attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new MongoRateLimitStore("caregiver-verify"),
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function issueAuthToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email, source: "custom" },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authorization token required" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { userId: payload.userId, source: "custom" };
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// ─── VALIDATION HELPERS ───────────────────────────────────────────────────────
function validateMedicationInput(medicationName, time, allowPast = false) {
  const errors = [];
  if (!medicationName || medicationName.trim() === "") errors.push("Medication name is required.");
  if (!time) {
    errors.push("Time is required.");
  } else {
    const t = new Date(time);
    if (isNaN(t.getTime())) errors.push("Invalid date/time.");
    else if (!allowPast && t <= new Date()) errors.push("Reminder time must be in the future.");
  }
  return errors;
}

// Sanitise a free-text dosage field from user input or AI extraction.
// Returns null if the value is empty or invalid.
function sanitiseDosage(rawDosage) {
  if (!rawDosage || typeof rawDosage !== "string") return null;
  const trimmed = rawDosage.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  return trimmed;
}

// Validate that a timezone string is a plausible IANA timezone identifier.
// This is a format check only; it does not verify the zone exists.
function isValidTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  if (tz.length > 64 || !/^[A-Za-z0-9_\-+/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// ─── OCCURRENCE HELPERS ───────────────────────────────────────────────────────

/**
 * Generate occurrence(s) for a new or edited reminder.
 * For one-time reminders: one occurrence at scheduledFor.
 * For daily reminders: occurrences for today through 7 days ahead.
 * Uses upsert to remain idempotent if called multiple times.
 */
async function generateOccurrences(medication) {
  const tz = medication.timezone || "UTC";
  const occurrences = buildOccurrenceDates(medication, new Date(), 14).map((scheduledFor) => ({
    reminderId: medication._id,
    userId: medication.userId,
    scheduledFor,
    timezone: tz,
    state: "due",
  }));

  // Upsert: insert new, skip existing (idempotent)
  for (const occ of occurrences) {
    await Occurrence.updateOne(
      { reminderId: occ.reminderId, scheduledFor: occ.scheduledFor },
      { $setOnInsert: occ },
      { upsert: true }
    );
  }
}

/**
 * Cancel all future occurrences for a reminder (on delete/pause).
 * Sets state to "cancelled" for any occurrence still in "due" state.
 */
async function cancelFutureOccurrences(reminderId, reason) {
  const pending = await Occurrence.find(
    { reminderId, state: "due", scheduledFor: { $gte: new Date() } },
    { _id: 1 }
  ).lean();
  if (!pending.length) return;
  const ids = pending.map((o) => o._id);
  await Occurrence.updateMany(
    { _id: { $in: ids }, state: "due" },
    { $set: { state: "cancelled", cancellationReason: reason } }
  );
  await AlertLog.updateMany(
    { occurrenceId: { $in: ids }, state: { $in: ["queued", "sending"] } },
    { $set: { state: "cancelled", cancellationReason: reason, leaseUntil: null } }
  );
}

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.json({ status: "Synergy backend running" }));

// Register
app.post("/register", async (req, res) => {
  const { name, email, phone, password } = req.body;
  const errors = [];
  if (!name || name.trim().length < 3) errors.push("Name must be at least 3 characters.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Valid email is required.");
  if (!password || password.length < 6) errors.push("Password must be at least 6 characters.");
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  try {
    const oldUser = await User.findOne({ email });
    if (oldUser) return res.status(400).json({ error: "User already exists!" });
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ name: name.trim(), email, phone: phone || undefined, password: hashedPassword });
    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    console.error("Error during registration:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
});

// Login
app.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password are required." });
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "User not found" });
    if (!user.password) return res.status(400).json({ message: "Invalid credentials" });
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(400).json({ message: "Invalid credentials" });
    const token = issueAuthToken(user);
    res.status(200).json({ token, userId: user._id.toString(), message: "Login successful" });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Google Sign-In
app.post("/auth/google", loginLimiter, async (req, res) => {
  if (!GOOGLE_WEB_CLIENT_ID) {
    return res.status(503).json({ message: "Google sign-in is not configured on this server." });
  }
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ message: "idToken is required." });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_WEB_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || payload.email_verified !== true) {
      return res.status(401).json({ message: "Invalid or unverified Google token" });
    }
    const { sub, email, name } = payload;
    if (!sub || !email) {
      return res.status(401).json({ message: "Invalid or unverified Google token" });
    }
    let user = await User.findOne({ googleId: sub });
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = sub;
        if (name && (!user.name || user.name.length < 3)) user.name = name;
        await user.save();
      } else {
        const displayName = name && name.trim().length >= 3 ? name.trim() : email.split("@")[0];
        const safeName = displayName.length >= 3 ? displayName : `${displayName}user`;
        user = await User.create({ name: safeName, email, googleId: sub });
      }
    }
    const token = issueAuthToken(user);
    res.status(200).json({ token, userId: user._id.toString(), message: "Login successful" });
  } catch {
    return res.status(401).json({ message: "Invalid or unverified Google token" });
  }
});

// ─── AI REMINDER PARSING ──────────────────────────────────────────────────────
// Single-shot and conversational parsing. Returns a draft for patient review;
// nothing is saved until the patient explicitly confirms.
app.post("/reminders/parse", authenticate, reminderParseLimiter, async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({ message: "AI parsing is unavailable. Please enter the reminder manually." });
  }

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (text.length < 3 || text.length > 500) {
    return res.status(400).json({ message: "Enter a reminder description between 3 and 500 characters." });
  }

  // Optional conversation history for multi-turn mode.
  // Each item: { role: "user"|"assistant", content: string }
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  const schema = {
    type: "object",
    properties: {
      medicationName: { type: "string" },
      // dosage: optional patient-stated dose (e.g. "1 tablet", "500 mg").
      // The model must ONLY include dosage if the user explicitly stated it.
      // It must NOT infer, recommend, or complete a dose amount.
      dosage: { type: ["string", "null"] },
      frequency: { type: "string", enum: ["daily", "once", "unsupported", "unclear"] },
      times: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            time: { type: ["string", "null"] },
          },
          required: ["label", "time"],
          additionalProperties: false,
        },
      },
      // clarificationNeeded: true when the AI needs more information from the patient.
      clarificationNeeded: { type: "boolean" },
      // clarificationPrompt: the question to show the patient when clarificationNeeded is true.
      clarificationPrompt: { type: ["string", "null"] },
    },
    required: ["medicationName", "dosage", "frequency", "times", "clarificationNeeded", "clarificationPrompt"],
    additionalProperties: false,
  };

  const systemPrompt = [
    "You are a medication reminder extraction assistant. Your only job is to extract a structured reminder schedule from what the patient tells you.",
    "RULES — follow these exactly:",
    "1. Extract the medicine name and strength exactly as stated; do not change it.",
    "2. Extract dosage ONLY if the patient explicitly stated an amount (e.g. '1 tablet', '5 ml', '500mg'). Otherwise set dosage to null. Never infer, guess, or recommend a dose.",
    "3. Set frequency to 'daily' for a recurring daily schedule, 'once' for a one-time reminder, 'unsupported' for weekly/monthly/other patterns, or 'unclear' when you cannot determine it.",
    "4. Create one times item per stated dose occurrence, up to four. Use descriptive labels (e.g. 'Morning', 'Before bed').",
    "5. Set time to the exact HH:mm 24-hour clock value ONLY if the patient gave a specific time. If they said 'morning', 'dinner', 'evening' without a clock time, set time to null. NEVER invent or guess clock times from meal words.",
    "6. If information is missing that is needed to complete the schedule, set clarificationNeeded to true and set clarificationPrompt to a single short question in the patient's language to collect that information.",
    "7. If everything needed is present, set clarificationNeeded to false and clarificationPrompt to null.",
    "8. Support both English and Hindi patient input equally.",
    "9. Never provide medical advice. Never suggest dosage. Never recommend medication changes.",
    "10. Return only data matching the required schema.",
  ].join(" ");

  // Build message list: system + any history + latest user message
  const messages = [{ role: "system", content: systemPrompt }];
  for (const turn of history) {
    if ((turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string") {
      messages.push({ role: turn.role, content: turn.content.slice(0, 1000) });
    }
  }
  messages.push({ role: "user", content: text });

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0,
        max_completion_tokens: 600,
        response_format: {
          type: "json_schema",
          json_schema: { name: "reminder_schedule", strict: true, schema },
        },
        messages,
      }),
    });

    if (response.status === 429) {
      return res.status(429).json({ message: "AI parsing is busy. Please enter the reminder manually or try again later." });
    }
    if (!response.ok) {
      console.error("Groq reminder parsing failed with status:", response.status);
      return res.status(502).json({ message: "AI parsing is unavailable right now. Please enter the reminder manually." });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return res.status(502).json({ message: "AI could not read that reminder. Please enter it manually." });
    }

    const parsed = JSON.parse(content);

    if (parsed.frequency === "unsupported") {
      return res.status(422).json({ message: "This app supports one-time and daily reminders. Please enter this schedule manually." });
    }
    if (parsed.frequency === "unclear" || !parsed.medicationName?.trim()) {
      return res.status(422).json({ message: "I couldn't identify a complete reminder. Add the medicine and schedule manually." });
    }
    if (!Array.isArray(parsed.times) || parsed.times.length < 1 || parsed.times.length > 4) {
      return res.status(422).json({ message: "AI returned an invalid schedule. Please enter the reminder manually." });
    }

    const validTimes = parsed.times.every(
      (item) =>
        item &&
        typeof item.label === "string" &&
        item.label.length <= 40 &&
        (item.time === null ||
          (typeof item.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)))
    );
    if (!validTimes || parsed.medicationName.length > 100) {
      return res.status(422).json({ message: "AI returned an invalid schedule. Please enter the reminder manually." });
    }

    return res.json({
      medicationName: parsed.medicationName.trim(),
      dosage: sanitiseDosage(parsed.dosage),
      frequency: parsed.frequency,
      times: parsed.times,
      clarificationNeeded: !!parsed.clarificationNeeded,
      clarificationPrompt: parsed.clarificationNeeded ? parsed.clarificationPrompt || null : null,
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return res.status(504).json({ message: "AI parsing took too long. Please enter the reminder manually." });
    }
    console.error("Error parsing reminder with Groq:", error?.message || "unknown error");
    return res.status(502).json({ message: "AI parsing failed. Please enter the reminder manually." });
  }
});

// ─── PROTECTED ROUTES ─────────────────────────────────────────────────────────

// ── Reminder CRUD ─────────────────────────────────────────────────────────────

// Create reminder
app.post("/addMedication", authenticate, async (req, res) => {
  const { medicationName, time, repeating, notificationId, dosage, timezone } = req.body;

  const errors = validateMedicationInput(medicationName, time);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    return res.status(400).json({ error: "timezone must be a valid IANA timezone identifier." });
  }
  if (dosage !== undefined && dosage !== null && typeof dosage !== "string") {
    return res.status(400).json({ error: "dosage must be text or null." });
  }
  if (typeof repeating !== "boolean") return res.status(400).json({ error: "repeating must be a boolean." });
  const tz = timezone || "UTC";

  try {
    const newMedication = new Medication({
      userId: req.user.userId,
      medicationName: medicationName.trim(),
      time: new Date(time),
      repeating,
      notificationId: notificationId || null,
      dosage: sanitiseDosage(dosage),
      timezone: tz,
      status: "active",
    });
    await newMedication.save();

    // Generate occurrence records for this reminder
    await generateOccurrences(newMedication);

    await ActivityLog.create({ userId: req.user.userId, medicationId: newMedication._id, action: "create" });

    res.status(201).json({
      success: true,
      message: "Medication added successfully",
      medication: newMedication,
      medicationId: newMedication._id.toHexString(),
    });
  } catch (error) {
    console.error("Error adding medication:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to add medication" });
  }
});

// Get reminders (active only, sorted by time)
app.get("/getReminders", authenticate, async (req, res) => {
  try {
    const reminders = await Medication.find({
      userId: req.user.userId,
      status: { $ne: "deleted" }, // includes legacy records without a status field
    }).sort({ time: 1 }).lean();
    for (const reminder of reminders) {
      if (!reminder.status) reminder.status = reminder.isActive === false ? "paused" : "active";
      if (reminder.status === "active") await generateOccurrences(reminder);
    }
    res.status(200).json({ reminders });
  } catch (error) {
    console.error("Error fetching reminders:", error);
    res.status(500).json({ error: "Failed to fetch reminders." });
  }
});

// Edit reminder
app.put("/medications/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { medicationName, time, repeating, notificationId, dosage, timezone } = req.body;

  const errors = validateMedicationInput(medicationName, time);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    return res.status(400).json({ error: "timezone must be a valid IANA timezone identifier." });
  }
  if (dosage !== undefined && dosage !== null && typeof dosage !== "string") {
    return res.status(400).json({ error: "dosage must be text or null." });
  }
  if (typeof repeating !== "boolean") return res.status(400).json({ error: "repeating must be a boolean." });

  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId, status: { $ne: "deleted" } });
    if (!medication) return res.status(404).json({ error: "Medication not found or access denied." });

    const oldTime = medication.time;
    const oldRepeating = medication.repeating;
    const oldTimezone = medication.timezone || "UTC";

    medication.medicationName = medicationName.trim();
    medication.time = new Date(time);
    medication.repeating = repeating;
    medication.notificationId = notificationId || null;
    if (Object.prototype.hasOwnProperty.call(req.body, "dosage")) {
      medication.dosage = sanitiseDosage(dosage);
    }
    if (timezone) medication.timezone = timezone;
    await medication.save();

    // If the schedule changed, cancel old future occurrences and generate new ones.
    const scheduleChanged = oldTime.getTime() !== medication.time.getTime() ||
      oldRepeating !== medication.repeating || oldTimezone !== medication.timezone;
    if (scheduleChanged) {
      await cancelFutureOccurrences(medication._id, "reminder edited");
      await generateOccurrences(medication);
    }

    await ActivityLog.create({ userId: req.user.userId, medicationId: medication._id, action: "edit" });

    res.status(200).json({ success: true, message: "Medication updated successfully", medication });
  } catch (error) {
    console.error("Error updating medication:", error);
    res.status(500).json({ success: false, error: "Failed to update medication" });
  }
});

// Soft-delete reminder (preserves occurrence history)
app.delete("/medications/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId, status: { $ne: "deleted" } });
    if (!medication) return res.status(404).json({ success: false, error: "Medication not found or access denied." });

    medication.status = "deleted";
    await medication.save();

    // Cancel any pending future occurrences
    await cancelFutureOccurrences(medication._id, "reminder deleted");

    await ActivityLog.create({ userId: req.user.userId, medicationId: id, action: "delete" });

    res.status(200).json({ success: true, message: "Medication deleted successfully" });
  } catch (error) {
    console.error("Error deleting medication:", error);
    res.status(500).json({ success: false, error: "Failed to delete medication" });
  }
});

// Pause reminder
app.patch("/medications/:id/pause", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId, status: { $ne: "deleted" } });
    if (!medication || medication.status === "paused" || medication.isActive === false) {
      return res.status(404).json({ error: "Active medication not found or access denied." });
    }

    medication.status = "paused";
    await medication.save();
    await cancelFutureOccurrences(medication._id, "reminder paused");
    await ActivityLog.create({ userId: req.user.userId, medicationId: id, action: "pause" });

    res.status(200).json({ success: true, message: "Reminder paused", medication });
  } catch (error) {
    console.error("Error pausing medication:", error);
    res.status(500).json({ error: "Failed to pause medication" });
  }
});

// Resume reminder
app.patch("/medications/:id/resume", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId, status: { $ne: "deleted" } });
    if (!medication || (medication.status !== "paused" && medication.isActive !== false)) {
      return res.status(404).json({ error: "Paused medication not found or access denied." });
    }

    medication.status = "active";
    await medication.save();

    // Re-generate future occurrences now that the reminder is active again
    await generateOccurrences(medication);
    await ActivityLog.create({ userId: req.user.userId, medicationId: id, action: "resume" });

    res.status(200).json({ success: true, message: "Reminder resumed", medication });
  } catch (error) {
    console.error("Error resuming medication:", error);
    res.status(500).json({ error: "Failed to resume medication" });
  }
});

// ── Occurrence-based actions (Taken / Skipped) ────────────────────────────────

async function queueSkippedDoseAlert(occurrence, userId) {
  const user = await User.findById(userId).select("caregiver alertSettings");
  if (!user?.alertSettings?.alertOnSkipped || !user.caregiver?.verified || !user.caregiver?.alertsEnabled || user.caregiver?.recipientOptedOut) return;
  const kind = "skipped";
  const idempotencyKey = `${kind}-${occurrence._id}-${user.caregiver.channel}`;
  await AlertLog.updateOne(
    { idempotencyKey },
    { $setOnInsert: {
      occurrenceId: occurrence._id,
      userId,
      channel: user.caregiver.channel,
      destination: user.caregiver.destination,
      kind,
      state: "queued",
      idempotencyKey,
      nextAttemptAt: new Date(),
    } },
    { upsert: true }
  );
  await Occurrence.updateOne({ _id: occurrence._id, state: "skipped" }, { $set: { caregiverAlertState: "queued" } });
}

// Record Taken or Skipped against an expected-dose occurrence.
app.post("/medications/:id/action", authenticate, async (req, res) => {
  const { id } = req.params; // medicationId
  const { action, occurrenceId } = req.body;
  const idempotencyKey = typeof req.body.idempotencyKey === "string" && req.body.idempotencyKey.length <= 100
    ? req.body.idempotencyKey
    : crypto.randomUUID();
  const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : new Date();

  if (!["taken", "skipped"].includes(action)) {
    return res.status(400).json({ error: "action must be 'taken' or 'skipped'" });
  }
  if (Number.isNaN(occurredAt.getTime()) || occurredAt > new Date(Date.now() + 5 * 60 * 1000) ||
      occurredAt < new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)) {
    return res.status(400).json({ error: "occurredAt must be a valid time within the past 14 days." });
  }

  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId, status: { $ne: "deleted" } });
    if (!medication) return res.status(404).json({ error: "Medication not found or access denied." });

    let occurrence;
    if (occurrenceId) {
      occurrence = await Occurrence.findOne({
        _id: occurrenceId,
        reminderId: medication._id,
        userId: req.user.userId,
      });
      if (!occurrence) {
        return res.status(404).json({ error: "Occurrence not found or access denied." });
      }
      if (occurrence.scheduledFor > new Date(occurredAt.getTime() + 5 * 60 * 1000)) {
        return res.status(400).json({ error: "This reminder occurrence is not due yet." });
      }
    } else {
      // Compatibility with clients that only send medicationId: bind to the
      // closest pending occurrence at the action's original device timestamp.
      await generateOccurrences(medication);
      // If the app was closed at the scheduled time, create the expected daily
      // occurrence for the action's local calendar day before resolving it.
      if (medication.repeating) {
        const zone = medication.timezone || "UTC";
        const actionDay = localDateString(occurredAt, zone);
        const clock = localClockString(medication.time, zone);
        const sameDayDue = localDateTimeToUtc(actionDay, clock, zone);
        const dueAt = sameDayDue && sameDayDue <= occurredAt ? sameDayDue :
          localDateTimeToUtc(addLocalDays(actionDay, -1), clock, zone);
        if (dueAt && dueAt <= occurredAt && occurredAt.getTime() - dueAt.getTime() <= 14 * 24 * 60 * 60 * 1000) {
          await Occurrence.updateOne(
            { reminderId: medication._id, scheduledFor: dueAt },
            { $setOnInsert: { reminderId: medication._id, userId: req.user.userId, scheduledFor: dueAt, timezone: zone, state: "due" } },
            { upsert: true }
          );
        }
      }
      occurrence = await Occurrence.findOne({
        reminderId: medication._id,
        userId: req.user.userId,
        state: { $in: ["due", "unconfirmed"] },
        scheduledFor: { $lte: occurredAt },
      }).sort({ scheduledFor: -1 });
      if (!occurrence) {
        occurrence = await Occurrence.findOne({
          reminderId: medication._id,
          userId: req.user.userId,
          state: { $in: ["due", "unconfirmed"] },
          scheduledFor: { $gt: occurredAt, $lte: new Date(occurredAt.getTime() + 60 * 60 * 1000) },
        }).sort({ scheduledFor: 1 });
      }
      if (!occurrence) {
        return res.status(409).json({ error: "No pending dose occurrence is available for this action." });
      }
    }

    if (["taken", "skipped"].includes(occurrence.state)) {
      if (occurrence.state === action) {
        if (action === "skipped") await queueSkippedDoseAlert(occurrence, req.user.userId);
        return res.status(200).json({
          success: true,
          idempotent: true,
          message: `Already recorded as ${occurrence.state}`,
          occurrenceId: occurrence._id,
          occurrence,
        });
      }
      return res.status(409).json({ error: `This occurrence has already been recorded as ${occurrence.state}.`, occurrence });
    }
    if (!["due", "unconfirmed"].includes(occurrence.state)) {
      return res.status(409).json({ error: `This occurrence is ${occurrence.state}.`, occurrence });
    }

    const updated = await Occurrence.findOneAndUpdate(
      { _id: occurrence._id, state: { $in: ["due", "unconfirmed"] } },
      { $set: { state: action, actionAt: occurredAt, actionIdempotencyKey: idempotencyKey } },
      { new: true }
    );
    if (!updated) {
      const latest = await Occurrence.findById(occurrence._id);
      if (latest && latest.state === action) {
        return res.status(200).json({ success: true, idempotent: true, occurrenceId: latest._id, occurrence: latest });
      }
      return res.status(409).json({ error: "This dose occurrence was updated by another request." });
    }

    await AlertLog.updateMany(
      { occurrenceId: updated._id, state: { $in: ["queued", "sending"] }, kind: "unconfirmed" },
      { $set: { state: "cancelled", cancellationReason: `Patient marked ${action}`, leaseUntil: null } }
    );
    await ActivityLog.create({ userId: req.user.userId, medicationId: id, action, timestamp: occurredAt }).catch(() => {
      console.warn("Activity log write failed; occurrence record remains authoritative.");
    });

    if (action === "skipped") {
      await queueSkippedDoseAlert(updated, req.user.userId);
    }

    res.status(200).json({
      success: true,
      message: `Marked as ${action}`,
      occurrenceId: updated._id,
      occurrence: updated,
    });
  } catch (error) {
    console.error("Error logging action:", error);
    res.status(500).json({ error: "Failed to log action" });
  }
});

// Get occurrences for a medication (for the client to display upcoming/past doses)
app.get("/medications/:id/occurrences", authenticate, async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;

  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId });
    if (!medication) return res.status(404).json({ error: "Medication not found or access denied." });

    const filter = { reminderId: id, userId: req.user.userId };
    if (from || to) {
      filter.scheduledFor = {};
      if (from) filter.scheduledFor.$gte = new Date(from);
      if (to) filter.scheduledFor.$lte = new Date(to);
    }

    const occurrences = await Occurrence.find(filter).sort({ scheduledFor: 1 }).limit(50);
    res.status(200).json({ success: true, occurrences });
  } catch (error) {
    console.error("Error fetching occurrences:", error);
    res.status(500).json({ error: "Failed to fetch occurrences" });
  }
});

// ── Adherence dashboard (7-day summary) ───────────────────────────────────────

// Returns occurrence-based counts where occurrences exist;
// falls back to ActivityLog counts for reminders created before occurrences were added.
app.get("/adherence", authenticate, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Primary: occurrence-based counts (source of truth going forward)
    const occurrences = await Occurrence.find({
      userId: req.user.userId,
      scheduledFor: { $gte: sevenDaysAgo },
      state: { $in: ["taken", "skipped", "unconfirmed", "due", "cancelled"] },
    }).sort({ scheduledFor: 1 });

    // Build 7-day buckets in UTC
    const byDate = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const key = d.toISOString().split("T")[0];
      byDate[key] = { taken: 0, skipped: 0, unconfirmed: 0, date: key };
    }

    let hasOccurrenceData = false;
    occurrences.forEach((occ) => {
      const key = occ.scheduledFor.toISOString().split("T")[0];
      if (byDate[key]) {
        if (occ.state === "taken") byDate[key].taken++;
        else if (occ.state === "skipped") byDate[key].skipped++;
        else if (occ.state === "unconfirmed") byDate[key].unconfirmed++;
        hasOccurrenceData = true;
      }
    });

    // Fallback: ActivityLog for backward compat with legacy action records
    if (!hasOccurrenceData) {
      const logs = await ActivityLog.find({
        userId: req.user.userId,
        action: { $in: ["taken", "skipped"] },
        timestamp: { $gte: sevenDaysAgo },
      }).sort({ timestamp: 1 });

      logs.forEach((log) => {
        const key = log.timestamp.toISOString().split("T")[0];
        if (byDate[key]) byDate[key][log.action]++;
      });
    }

    const aggregated = Object.values(byDate);
    const totalTaken = aggregated.reduce((s, d) => s + d.taken, 0);
    const totalSkipped = aggregated.reduce((s, d) => s + d.skipped, 0);
    const totalUnconfirmed = aggregated.reduce((s, d) => s + d.unconfirmed, 0);
    const totalDoses = totalTaken + totalSkipped + totalUnconfirmed;

    res.status(200).json({
      success: true,
      aggregated,
      totalTaken,
      totalSkipped,
      totalUnconfirmed,
      totalDoses,
      source: hasOccurrenceData ? "occurrences" : "activity_log_legacy",
    });
  } catch (error) {
    console.error("Error fetching adherence:", error);
    res.status(500).json({ error: "Failed to fetch adherence data" });
  }
});

// AI weekly summary — uses aggregate counts only; no PII sent to LLM
app.get("/adherence/summary", authenticate, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const occurrences = await Occurrence.find({
      userId: req.user.userId,
      scheduledFor: { $gte: sevenDaysAgo },
      state: { $in: ["taken", "skipped", "unconfirmed"] },
    });

    let totalTaken = 0, totalDoses = 0;
    const byDay = {};

    if (occurrences.length > 0) {
      totalTaken = occurrences.filter((o) => o.state === "taken").length;
      totalDoses = occurrences.length;
      occurrences.forEach((occ) => {
        const day = occ.scheduledFor.toLocaleDateString("en-US", { weekday: "long" });
        if (!byDay[day]) byDay[day] = { taken: 0, skipped: 0, unconfirmed: 0 };
        if (occ.state === "taken") byDay[day].taken++;
        else if (occ.state === "skipped") byDay[day].skipped++;
        else byDay[day].unconfirmed++;
      });
    } else {
      // Fallback to ActivityLog
      const logs = await ActivityLog.find({
        userId: req.user.userId,
        action: { $in: ["taken", "skipped"] },
        timestamp: { $gte: sevenDaysAgo },
      });
      totalTaken = logs.filter((l) => l.action === "taken").length;
      totalDoses = logs.length;
      logs.forEach((log) => {
        const day = log.timestamp.toLocaleDateString("en-US", { weekday: "long" });
        if (!byDay[day]) byDay[day] = { taken: 0, skipped: 0, unconfirmed: 0 };
        byDay[day][log.action]++;
      });
    }

    if (totalDoses === 0) {
      return res.status(200).json({
        success: false,
        summary: null,
        reason: "No dose actions recorded this week",
        totalTaken: 0,
        totalDoses: 0,
      });
    }

    if (!GROQ_API_KEY) {
      return res.status(200).json({ success: false, summary: null, reason: "GROQ_API_KEY not configured", totalTaken, totalDoses });
    }

    const daySummary = Object.entries(byDay)
      .map(([day, counts]) => `${day}: ${counts.taken} taken, ${counts.skipped} skipped, ${counts.unconfirmed} unconfirmed`)
      .join("; ");

    const prompt = [
      "You are a medication adherence assistant writing a brief weekly summary for a patient.",
      "Rules: do not mention medication names; do not give medical advice; do not recommend dose changes;",
      "do not use the word 'missed' — say 'unconfirmed' instead; keep it under 60 words; be encouraging and factual.",
      `Data: ${totalTaken} of ${totalDoses} expected doses recorded as taken this week.`,
      `Day breakdown: ${daySummary || "no breakdown available"}.`,
    ].join(" ");

    const groqBody = JSON.stringify({
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
      temperature: 0.4,
    });

    const groqOptions = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(groqBody),
      },
    };

    const summary = await new Promise((resolve, reject) => {
      const request = https.request(groqOptions, (response) => {
        let data = "";
        response.on("data", (chunk) => { data += chunk; });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.choices?.[0]?.message?.content?.trim() || null);
          } catch {
            reject(new Error("Failed to parse Groq response"));
          }
        });
      });
      request.on("error", reject);
      request.write(groqBody);
      request.end();
    });

    res.status(200).json({ success: true, summary, totalTaken, totalDoses });
  } catch (error) {
    console.error("Error generating AI summary:", error);
    res.status(200).json({ success: false, summary: null, reason: "AI summary unavailable" });
  }
});

// ── Caregiver Settings ────────────────────────────────────────────────────────

function hashToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function publicApiBase() {
  return (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
}

async function sendCaregiverVerification(user, token) {
  const base = publicApiBase();
  if (!base) throw new Error("APP_BASE_URL is not configured");
  const link = `${base}/caregiver/verify?token=${encodeURIComponent(token)}`;
  const text = `A Synergy patient asked to use this address for one-way reminder alerts. Verify this contact: ${link}\nIf you did not expect this, ignore this message.`;
  if (user.caregiver.channel === "email") {
    return sendEmail({ to: user.caregiver.destination, subject: "Verify Synergy caregiver alerts", text });
  }
  return sendSms({ to: user.caregiver.destination, text });
}

// Get caregiver settings (patient's own record only)
app.get("/user/caregiver", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("caregiver alertSettings");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.status(200).json({
      success: true,
      caregiver: {
        channel: user.caregiver?.channel || null,
        // Only return whether a destination is set, never the raw value
        hasDestination: !!(user.caregiver?.destination),
        verified: user.caregiver?.verified || false,
        alertsEnabled: user.caregiver?.alertsEnabled || false,
        recipientOptedOut: user.caregiver?.recipientOptedOut || false,
      },
      alertSettings: user.alertSettings || {},
    });
  } catch (error) {
    console.error("Error fetching caregiver settings:", error);
    res.status(500).json({ error: "Failed to fetch caregiver settings" });
  }
});

// Configure caregiver contact (sets channel and destination; resets verification)
app.put("/user/caregiver", authenticate, caregiverVerifyLimiter, async (req, res) => {
  const { channel, destination } = req.body;

  if (!["email", "sms"].includes(channel)) {
    return res.status(400).json({ error: "channel must be 'email' or 'sms'" });
  }
  if (!destination || typeof destination !== "string" || destination.trim().length < 5) {
    return res.status(400).json({ error: "A valid destination (email address or phone number) is required." });
  }

  // Validate format based on channel
  const dest = channel === "sms"
    ? normalizeCaregiverPhone(destination)
    : destination.trim();
  if (!dest) {
    return res.status(400).json({
      error: "Enter a valid phone number. Indian 10-digit mobile numbers are accepted; international numbers must include their country code.",
    });
  }
  if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) {
    return res.status(400).json({ error: "A valid email address is required for email alerts." });
  }
  if (!publicApiBase()) return res.status(503).json({ error: "APP_BASE_URL is required for contact verification links." });
  if (!isChannelConfigured(channel)) return res.status(503).json({ error: `${channel.toUpperCase()} delivery is not configured on the server.` });

  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.caregiver?.channel === channel && user.caregiver?.destination === dest &&
        user.caregiver?.verified && !user.caregiver?.recipientOptedOut) {
      return res.json({ success: true, verified: true, message: "This contact is already verified." });
    }

    // Changing destination resets verification and disables alerts until re-verified
    const verificationToken = crypto.randomBytes(32).toString("base64url");
    user.caregiver = {
      channel,
      destination: dest,
      verified: false,
      verificationTokenHash: hashToken(verificationToken),
      verificationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      consentVersion: crypto.randomUUID(),
      alertsEnabled: false,
      recipientOptedOut: false,
    };
    await user.save();

    try {
      await sendCaregiverVerification(user, verificationToken);
    } catch (sendError) {
      console.error("Caregiver verification send failed:", sendError.message);
      return res.status(502).json({ error: "Contact saved but verification could not be delivered. Check provider settings and retry." });
    }

    res.status(200).json({
      success: true,
      verified: false,
      message: `Verification link sent by ${channel}. Alerts remain disabled until the recipient verifies.`,
    });
  } catch (error) {
    console.error("Error updating caregiver settings:", error);
    res.status(500).json({ error: "Failed to update caregiver settings" });
  }
});

app.post("/user/caregiver/resend-verification", authenticate, caregiverVerifyLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user?.caregiver?.destination || user.caregiver.verified || user.caregiver.recipientOptedOut) {
      return res.status(400).json({ error: "There is no pending caregiver verification." });
    }
    if (!publicApiBase() || !isChannelConfigured(user.caregiver.channel)) {
      return res.status(503).json({ error: "Configure APP_BASE_URL and the selected messaging provider first." });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    user.caregiver.verificationTokenHash = hashToken(token);
    user.caregiver.verificationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();
    await sendCaregiverVerification(user, token);
    return res.json({ success: true, message: "Verification link sent." });
  } catch (error) {
    console.error("Caregiver verification resend failed:", error.message);
    return res.status(502).json({ error: "Verification message could not be sent." });
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

function confirmationPage(title, message, action, token, buttonLabel) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><main><h1>${title}</h1><p>${message}</p><form method="post" action="${action}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">${buttonLabel}</button></form></main></body></html>`;
}

app.get("/caregiver/verify", caregiverVerifyLimiter, async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token || token.length > 200) return res.status(400).type("text").send("Invalid verification link.");
  try {
    const user = await User.findOne({
      "caregiver.verificationTokenHash": hashToken(token),
      "caregiver.verificationTokenExpiresAt": { $gt: new Date() },
    });
    if (!user) return res.status(400).type("text").send("This verification link is invalid or expired.");
    return res.type("html").send(confirmationPage(
      "Verify Synergy alerts",
      "Confirm that you agree to receive one-way caregiver check-in messages for this patient.",
      "/caregiver/verify",
      token,
      "Confirm and enable alerts"
    ));
  } catch (error) {
    console.error("Caregiver verification link check failed:", error.message);
    return res.status(500).type("text").send("Verification could not be completed. Please try again.");
  }
});

app.post("/caregiver/verify", caregiverVerifyLimiter, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token || token.length > 200) return res.status(400).type("text").send("Invalid verification link.");
  try {
    const user = await User.findOne({
      "caregiver.verificationTokenHash": hashToken(token),
      "caregiver.verificationTokenExpiresAt": { $gt: new Date() },
    });
    if (!user) return res.status(400).type("text").send("This verification link is invalid or expired.");
    user.caregiver.verified = true;
    user.caregiver.alertsEnabled = true;
    user.caregiver.verificationTokenHash = null;
    user.caregiver.verificationTokenExpiresAt = null;
    await user.save();
    return res.type("text").send("Caregiver contact verified. The patient can now configure Synergy alerts.");
  } catch (error) {
    console.error("Caregiver verification failed:", error.message);
    return res.status(500).type("text").send("Verification could not be completed. Please try again.");
  }
});

// Update alert timing settings
app.patch("/user/alert-settings", authenticate, async (req, res) => {
  const { followUpMinutes, caregiverAlertMinutes, alertOnSkipped } = req.body;
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    const follow = followUpMinutes === undefined ? user.alertSettings.followUpMinutes : Number(followUpMinutes);
    const caregiver = caregiverAlertMinutes === undefined ? user.alertSettings.caregiverAlertMinutes : Number(caregiverAlertMinutes);
    if (!Number.isInteger(follow) || follow < 5 || follow > 120) {
      return res.status(400).json({ error: "followUpMinutes must be an integer between 5 and 120." });
    }
    if (!Number.isInteger(caregiver) || caregiver < 6 || caregiver > 180 || caregiver <= follow) {
      return res.status(400).json({ error: "caregiverAlertMinutes must be greater than followUpMinutes and at most 180." });
    }
    if (alertOnSkipped !== undefined && typeof alertOnSkipped !== "boolean") {
      return res.status(400).json({ error: "alertOnSkipped must be a boolean." });
    }
    user.alertSettings.followUpMinutes = follow;
    user.alertSettings.caregiverAlertMinutes = caregiver;
    if (alertOnSkipped !== undefined) user.alertSettings.alertOnSkipped = alertOnSkipped;
    await user.save();
    res.status(200).json({ success: true, alertSettings: user.alertSettings });
  } catch (error) {
    console.error("Error updating alert settings:", error.message);
    res.status(500).json({ error: "Failed to update alert settings" });
  }
});

// Disable caregiver alerts (patient revocation)
app.delete("/user/caregiver", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.caregiver = {
      channel: null,
      destination: null,
      verified: false,
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
      consentVersion: null,
      alertsEnabled: false,
      recipientOptedOut: false,
    };
    await user.save();
    await AlertLog.updateMany({ userId: req.user.userId, state: { $in: ["queued", "sending"] } }, {
      $set: { state: "cancelled", cancellationReason: "Patient removed caregiver contact", leaseUntil: null },
    });
    res.status(200).json({ success: true, message: "Caregiver contact removed and alerts disabled." });
  } catch (error) {
    console.error("Error removing caregiver:", error);
    res.status(500).json({ error: "Failed to remove caregiver contact" });
  }
});

// Opt-out endpoint — called by the caregiver recipient via a link in the alert message.
// Does not require authentication since the recipient has no account.
app.post("/caregiver-optout", async (req, res) => {
  const result = await applyCaregiverOptOut(req.body?.token);
  res.status(result.status).json({ message: result.message });
});

async function applyCaregiverOptOut(token) {
  if (!token || typeof token !== "string" || token.length > 2000) return { status: 400, message: "Invalid opt-out link." };
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.action !== "caregiver_opt_out" || !decoded.sub || !decoded.destinationHash || !decoded.consentVersion) {
      return { status: 400, message: "Invalid opt-out link." };
    }
    const user = await User.findById(decoded.sub);
    if (!user?.caregiver?.destination || user.caregiver.consentVersion !== decoded.consentVersion ||
        hashToken(user.caregiver.destination) !== decoded.destinationHash) {
      return { status: 400, message: "This opt-out link has expired." };
    }
    user.caregiver.recipientOptedOut = true;
    user.caregiver.alertsEnabled = false;
    await user.save();
    await AlertLog.updateMany({ userId: user._id.toString(), state: { $in: ["queued", "sending"] } }, {
      $set: { state: "cancelled", cancellationReason: "Recipient opted out", leaseUntil: null },
    });
    return { status: 200, message: "You have been opted out of Synergy caregiver alerts." };
  } catch {
    return { status: 400, message: "This opt-out link is invalid or expired." };
  }
}

app.get("/caregiver-optout", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token || token.length > 2000) return res.status(400).type("text").send("Invalid opt-out link.");
  return res.type("html").send(confirmationPage(
    "Stop caregiver alerts",
    "Confirm that you want to stop receiving Synergy caregiver check-in messages.",
    "/caregiver-optout",
    token,
    "Stop future alerts"
  ));
});

function validTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !publicApiBase()) return false;
  const signature = req.get("x-twilio-signature") || "";
  const url = `${publicApiBase()}${req.originalUrl}`;
  const canonical = Object.keys(req.body || {}).sort().reduce(
    (value, key) => value + key + String(req.body[key]),
    url
  );
  const expected = crypto.createHmac("sha1", authToken).update(canonical).digest("base64");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

app.post("/webhooks/twilio/inbound", async (req, res) => {
  if (!validTwilioSignature(req)) return res.status(403).type("text").send("Forbidden");
  const sender = typeof req.body.From === "string" ? req.body.From : "";
  const keywords = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
  if (keywords.has(String(req.body.Body || "").trim().toUpperCase())) {
    const user = await User.findOne({ "caregiver.channel": "sms", "caregiver.destination": sender });
    if (user) {
      user.caregiver.recipientOptedOut = true;
      user.caregiver.alertsEnabled = false;
      await user.save();
      await AlertLog.updateMany({ userId: user._id.toString(), state: { $in: ["queued", "sending"] } }, {
        $set: { state: "cancelled", cancellationReason: "Recipient replied STOP", leaseUntil: null },
      });
    }
  }
  return res.status(200).type("text/xml").send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Synergy backend running on port ${PORT}`);
});

function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully…`);
  server.close(async () => {
    try {
      await mongoose.connection.close();
      console.log("Database connection closed.");
    } catch (err) {
      console.error("Error closing database connection:", err);
    }
    process.exit(0);
  });
  // Force shutdown if it takes too long
  setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 15000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

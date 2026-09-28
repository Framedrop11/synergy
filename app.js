require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const https = require("https");
const { OAuth2Client } = require("google-auth-library");

const User = require("./UserDetails");
const Medication = require("./MedicationDetails");
const ActivityLog = require("./ActivityLog");

const app = express();
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;

if (!GOOGLE_WEB_CLIENT_ID) {
  console.warn("GOOGLE_WEB_CLIENT_ID is not set. Google sign-in is disabled until it is configured.");
}

const googleClient = new OAuth2Client();

// ─── CORS & JSON ────────────────────────────────────────────────────────────
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "PUT"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── DATABASE ────────────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Database connected"))
  .catch((err) => console.error("Error connecting to database:", err));

// ─── RATE LIMITER (Step 1.6) — login route only ───────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── AUTH ────────────────────────────────────────────────────────────────────
// Verifies our own HMAC-signed JWT (email/password and Google login both issue this).

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
    ActivityLog.create({ userId: payload.userId, action: "auth_check", meta: "valid" }).catch(() => {});
    return next();
  } catch {
    ActivityLog.create({ userId: "unknown", action: "auth_check", meta: "rejected" }).catch(() => {});
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function validateMedicationInput(medicationName, time) {
  const errors = [];
  if (!medicationName || medicationName.trim() === "") errors.push("Medication name is required.");
  if (!time) {
    errors.push("Time is required.");
  } else {
    const t = new Date(time);
    if (isNaN(t.getTime())) errors.push("Invalid date/time.");
    if (t <= new Date()) errors.push("Reminder time must be in the future.");
  }
  return errors;
}

// ─── PUBLIC ROUTES ──────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.json({ status: "Synergy backend running" }));

// Register (Step 1.7 — validate input)
app.post("/register", async (req, res) => {
  const { name, email, phone, password } = req.body;
  const errors = [];
  if (!name || name.trim().length < 3) errors.push("Name must be at least 3 characters.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Valid email is required.");
  if (!phone || !/^\d{10}$/.test(phone)) errors.push("Phone must be 10 digits.");
  if (!password || password.length < 6) errors.push("Password must be at least 6 characters.");
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  try {
    const oldUser = await User.findOne({ email });
    if (oldUser) return res.status(400).json({ error: "User already exists!" });

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ name, email, phone, password: hashedPassword });
    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    console.error("Error during registration:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
});

// Login — rate limited, issues a signed JWT
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

// Google Sign-In — verify Google ID token, issue the same JWT shape as /login
app.post("/auth/google", loginLimiter, async (req, res) => {
  if (!GOOGLE_WEB_CLIENT_ID) {
    return res.status(503).json({ message: "Google sign-in is not configured on this server." });
  }

  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ message: "idToken is required." });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_WEB_CLIENT_ID,
    });
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
        const displayName = (name && name.trim().length >= 3) ? name.trim() : email.split("@")[0];
        const safeName = displayName.length >= 3 ? displayName : `${displayName}user`;
        user = await User.create({
          name: safeName,
          email,
          googleId: sub,
        });
      }
    }

    const token = issueAuthToken(user);
    res.status(200).json({ token, userId: user._id.toString(), message: "Login successful" });
  } catch {
    return res.status(401).json({ message: "Invalid or unverified Google token" });
  }
});

// ─── PROTECTED ROUTES (all require authenticate middleware) ─────────────────

// Add medication (Step 1.3 — userId from token; Step 1.7 — validation)
app.post("/addMedication", authenticate, async (req, res) => {
  const { medicationName, time, repeating, notificationId } = req.body;

  const errors = validateMedicationInput(medicationName, time);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  try {
    const newMedication = new Medication({
      userId: req.user.userId,           // Step 1.3 — scoped to authenticated user
      medicationName: medicationName.trim(),
      time: new Date(time),
      repeating: !!repeating,
      notificationId: notificationId || null,
    });

    await newMedication.save();

    // Step 1.9 — log create action
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

// Get reminders — scoped to authenticated user (Step 1.4)
app.get("/getReminders", authenticate, async (req, res) => {
  try {
    const reminders = await Medication.find({ userId: req.user.userId, isActive: true }).sort({ time: 1 });
    res.status(200).json({ reminders });
  } catch (error) {
    console.error("Error fetching reminders:", error);
    res.status(500).json({ error: "Failed to fetch reminders." });
  }
});

// Edit medication (Step 1.8 — new PUT route, scoped to owner)
app.put("/medications/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { medicationName, time, repeating, notificationId } = req.body;

  const errors = validateMedicationInput(medicationName, time);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId });
    if (!medication) return res.status(404).json({ error: "Medication not found or access denied." });

    medication.medicationName = medicationName.trim();
    medication.time = new Date(time);
    medication.repeating = !!repeating;
    medication.notificationId = notificationId || null;
    await medication.save();

    // Step 1.9 — log edit action
    await ActivityLog.create({ userId: req.user.userId, medicationId: medication._id, action: "edit" });

    res.status(200).json({ success: true, message: "Medication updated successfully", medication });
  } catch (error) {
    console.error("Error updating medication:", error);
    res.status(500).json({ success: false, error: "Failed to update medication" });
  }
});

// Delete medication — scoped to owner (Step 1.3)
app.delete("/medications/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const medication = await Medication.findOneAndDelete({ _id: id, userId: req.user.userId });
    if (!medication) return res.status(404).json({ success: false, error: "Medication not found or access denied." });

    // Step 1.9 — log delete action
    await ActivityLog.create({ userId: req.user.userId, medicationId: id, action: "delete" });

    res.status(200).json({ success: true, message: "Medication deleted successfully" });
  } catch (error) {
    console.error("Error deleting medication:", error);
    res.status(500).json({ success: false, error: "Failed to delete medication" });
  }
});

// ─── STEP 2.1 — Mark taken / skipped ────────────────────────────────────────
app.post("/medications/:id/action", authenticate, async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;

  if (!["taken", "skipped"].includes(action)) {
    return res.status(400).json({ error: "action must be 'taken' or 'skipped'" });
  }

  try {
    const medication = await Medication.findOne({ _id: id, userId: req.user.userId });
    if (!medication) return res.status(404).json({ error: "Medication not found or access denied." });

    await ActivityLog.create({ userId: req.user.userId, medicationId: id, action });
    res.status(200).json({ success: true, message: `Marked as ${action}` });
  } catch (error) {
    console.error("Error logging action:", error);
    res.status(500).json({ error: "Failed to log action" });
  }
});

// ─── STEP 2.2 — Adherence dashboard data (last 7 days) ───────────────────────
app.get("/adherence", authenticate, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const logs = await ActivityLog.find({
      userId: req.user.userId,
      action: { $in: ["taken", "skipped"] },
      timestamp: { $gte: sevenDaysAgo },
    }).sort({ timestamp: 1 });

    // Aggregate by date
    const byDate = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const key = d.toISOString().split("T")[0];
      byDate[key] = { taken: 0, skipped: 0, date: key };
    }

    logs.forEach((log) => {
      const key = log.timestamp.toISOString().split("T")[0];
      if (byDate[key]) byDate[key][log.action]++;
    });

    const aggregated = Object.values(byDate);
    const totalTaken = aggregated.reduce((s, d) => s + d.taken, 0);
    const totalDoses = aggregated.reduce((s, d) => s + d.taken + d.skipped, 0);

    res.status(200).json({ success: true, aggregated, totalTaken, totalDoses });
  } catch (error) {
    console.error("Error fetching adherence:", error);
    res.status(500).json({ error: "Failed to fetch adherence data" });
  }
});

// ─── STEP 2.3 — AI weekly summary via Groq ───────────────────────────────────
app.get("/adherence/summary", authenticate, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const logs = await ActivityLog.find({
      userId: req.user.userId,
      action: { $in: ["taken", "skipped"] },
      timestamp: { $gte: sevenDaysAgo },
    });

    const totalTaken = logs.filter((l) => l.action === "taken").length;
    const totalDoses = logs.length;

    // Build per-day summary (no medication names — no PII sent to LLM)
    const byDay = {};
    logs.forEach((log) => {
      const day = log.timestamp.toLocaleDateString("en-US", { weekday: "long" });
      if (!byDay[day]) byDay[day] = { taken: 0, skipped: 0 };
      byDay[day][log.action]++;
    });

    const daySummary = Object.entries(byDay)
      .map(([day, counts]) => `${day}: ${counts.taken} taken, ${counts.skipped} missed`)
      .join("; ");

    const prompt = `You are a helpful medication adherence assistant. Based on this weekly data, write a 1-2 sentence encouraging and actionable summary for the patient. Do not mention medication names. Data: ${totalTaken} of ${totalDoses} doses taken this week. Day breakdown: ${daySummary || "no data"}. Keep it warm, brief, and motivational.`;

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey || groqApiKey === "YOUR_GROQ_KEY_HERE") {
      return res.status(200).json({ success: false, summary: null, reason: "GROQ_API_KEY not configured" });
    }

    const groqBody = JSON.stringify({
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.7,
    });

    const groqOptions = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqApiKey}`,
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
    // Step 2.3 constraint: fail gracefully — dashboard must work without AI
    console.error("Error generating AI summary:", error);
    res.status(200).json({ success: false, summary: null, reason: "AI summary unavailable" });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Synergy backend running on port ${PORT}`);
});

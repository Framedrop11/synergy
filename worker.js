/**
 * worker.js — Synergy durable escalation worker
 *
 * Runs as a separate process alongside app.js.
 * Responsibilities:
 *   1. Scan every minute for "due" occurrences that have passed their scheduled time
 *      and mark them "unconfirmed".
 *   2. After followUpMinutes: queue caregiver alert jobs (AlertLog state=queued).
 *   3. After caregiverAlertMinutes: attempt to send caregiver alerts.
 *   4. Cancel queued alerts for occurrences where the patient has since acted.
 *
 * Uses node-cron for scheduling (Redis/BullMQ retained for Render managed Redis
 * when REDIS_URL is configured; falls back to in-process cron without persistence).
 *
 * IMPORTANT: Caregiver alert delivery (email/SMS) requires provider credentials:
 *   - Email: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
 *   - SMS: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 * If credentials are absent the worker runs but skips alert delivery and logs the intent.
 */

require("dotenv").config();

const cron = require("node-cron");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const Occurrence = require("./Occurrence");
const AlertLog = require("./AlertLog");
const User = require("./UserDetails");
const Medication = require("./MedicationDetails");
const { buildOccurrenceDates } = require("./scheduleTime");
const { isChannelConfigured, sendEmail, sendSms, providerDiagnostic } = require("./notificationProviders");
const JWT_SECRET = process.env.JWT_SECRET;

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("FATAL: MONGO_URI is required for worker.");
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("FATAL: worker requires the same strong JWT_SECRET as the API.");
  process.exit(1);
}

// ─── Database ─────────────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("[Worker] Database connected"))
  .catch((err) => {
    console.error("[Worker] Error connecting to database:", err);
    process.exit(1);
  });

// ─── Alert sending functions ──────────────────────────────────────────────────

function recipientOptOutUrl(user) {
  const base = process.env.APP_BASE_URL;
  if (!base) return null;
  const destinationHash = crypto.createHash("sha256").update(user.caregiver.destination).digest("hex");
  const token = jwt.sign({
    sub: user._id.toString(),
    action: "caregiver_opt_out",
    destinationHash,
    consentVersion: user.caregiver.consentVersion,
  }, JWT_SECRET, { expiresIn: "3650d" });
  return `${base.replace(/\/$/, "")}/caregiver-optout?token=${encodeURIComponent(token)}`;
}

function composeAlertMessage(kind, optOutUrl) {
  const reason = kind === "skipped"
    ? "The patient marked a scheduled reminder as skipped."
    : "A scheduled reminder has not been confirmed.";
  const text = [
    `Synergy check-in: ${reason}`,
    "Please check in with the patient if appropriate. This is not an emergency alert.",
    optOutUrl ? `Stop future alerts: ${optOutUrl}` : "",
  ].filter(Boolean).join("\n");
  return { subject: "Synergy check-in reminder", text };
}

async function sendAlert(alertLog, user) {
  const { subject, text } = composeAlertMessage(alertLog.kind, recipientOptOutUrl(user));
  if (alertLog.channel === "email") {
    const result = await sendEmail({
      to: user.caregiver.destination,
      subject,
      text,
      unsubscribeUrl: recipientOptOutUrl(user),
    });
    return result.messageId;
  }
  const result = await sendSms({ to: user.caregiver.destination, text });
  return result.messageId;
}

// ─── Worker tasks ─────────────────────────────────────────────────────────────

/** Mark an occurrence unconfirmed at the patient-configured follow-up threshold. */
async function markOverdueOccurrences() {
  try {
    const now = new Date();
    const due = await Occurrence.find({ state: "due", scheduledFor: { $lte: now } }).limit(500);
    let changed = 0;
    for (const occurrence of due) {
      const user = await User.findById(occurrence.userId).select("alertSettings.followUpMinutes");
      const minutes = user?.alertSettings?.followUpMinutes ?? 30;
      const threshold = new Date(occurrence.scheduledFor.getTime() + minutes * 60_000);
      if (threshold > now) continue;
      const result = await Occurrence.updateOne(
        { _id: occurrence._id, state: "due" },
        { $set: { state: "unconfirmed", unconfirmedAt: now } }
      );
      changed += result.modifiedCount || 0;
    }
    if (changed) {
      console.log(`[Worker] Marked ${changed} occurrence(s) as unconfirmed.`);
    }
  } catch (err) {
    console.error("[Worker] Error marking overdue occurrences:", err.message);
  }
}

/**
 * Queue caregiver alerts at the configured (45-minute default) threshold.
 */
async function queueCaregiverAlerts() {
  try {
    const now = new Date();

    // Only unconfirmed occurrences can trigger a non-response alert.
    const candidates = await Occurrence.find({
      state: "unconfirmed",
      caregiverAlertState: "none",
      unconfirmedAt: { $ne: null },
    }).limit(100);

    for (const occ of candidates) {
      try {
        // Look up the patient's alert settings and caregiver config
        const user = await User.findById(occ.userId).select("caregiver alertSettings name");
        if (!user || !user.caregiver?.alertsEnabled || !user.caregiver?.verified || user.caregiver?.recipientOptedOut) {
          continue; // No caregiver alert configured or enabled
        }

        const alertDelayMs = (user.alertSettings?.caregiverAlertMinutes || 45) * 60_000;
        const alertDueAt = new Date(occ.scheduledFor.getTime() + alertDelayMs);

        if (now < alertDueAt) {
          continue; // Not time to send yet
        }

        const idempotencyKey = `caregiver-${occ._id}-${user.caregiver.channel}`;
        const queued = await AlertLog.updateOne(
          { idempotencyKey },
          { $setOnInsert: {
            occurrenceId: occ._id,
            userId: occ.userId,
            channel: user.caregiver.channel,
            destination: user.caregiver.destination,
            kind: "unconfirmed",
            state: "queued",
            idempotencyKey,
            nextAttemptAt: now,
          } },
          { upsert: true }
        );
        if (queued.upsertedCount) {
          await Occurrence.updateOne({ _id: occ._id, state: "unconfirmed", caregiverAlertState: "none" }, {
            $set: { caregiverAlertState: "queued" },
          });
          console.log(`[Worker] Queued caregiver alert for occurrence ${occ._id}`);
        }
      } catch (innerErr) {
        console.error(`[Worker] Error processing occurrence ${occ._id}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error("[Worker] Error queuing caregiver alerts:", err.message);
  }
}

/**
 * Task 3 (every minute): Send queued caregiver alerts with bounded retries.
 */
async function sendQueuedAlerts() {
  try {
    const now = new Date();
    await AlertLog.updateMany(
      { state: "sending", leaseUntil: { $lte: now } },
      { $set: { state: "queued", leaseUntil: null, nextAttemptAt: now } }
    );
    const queued = await AlertLog.find({
      state: "queued",
      attempts: { $lt: 3 },
      $or: [
        { nextAttemptAt: null },
        { nextAttemptAt: { $lte: now } },
      ],
    }).limit(50);

    for (const candidate of queued) {
      const alertLog = await AlertLog.findOneAndUpdate(
        { _id: candidate._id, state: "queued", attempts: { $lt: 3 } },
        { $set: { state: "sending", lastAttemptAt: now, leaseUntil: new Date(now.getTime() + 60_000) }, $inc: { attempts: 1 } },
        { new: true }
      );
      if (!alertLog) continue;
      try {
        const occ = await Occurrence.findById(alertLog.occurrenceId);
        const shouldSend = alertLog.kind === "skipped" ? occ?.state === "skipped" : occ?.state === "unconfirmed";
        if (!occ || !shouldSend) {
          alertLog.state = "cancelled";
          alertLog.cancellationReason = "Occurrence no longer matches this alert";
          alertLog.leaseUntil = null;
          await alertLog.save();
          continue;
        }

        const user = await User.findById(alertLog.userId).select("caregiver");
        if (!user || !user.caregiver?.alertsEnabled || !user.caregiver?.verified || user.caregiver?.recipientOptedOut ||
            user.caregiver.channel !== alertLog.channel || user.caregiver.destination !== alertLog.destination) {
          alertLog.state = "cancelled";
          alertLog.cancellationReason = "Caregiver contact changed, disabled, unverified, or opted out";
          alertLog.leaseUntil = null;
          await alertLog.save();
          continue;
        }

        if (!isChannelConfigured(alertLog.channel)) {
          alertLog.state = "failed";
          alertLog.lastErrorSummary = `${alertLog.channel} provider is not configured`;
          alertLog.leaseUntil = null;
          await alertLog.save();
          await Occurrence.updateOne({ _id: occ._id, caregiverAlertState: "queued" }, { $set: { caregiverAlertState: "failed" } });
          continue;
        }

        const messageId = await sendAlert(alertLog, user);
        alertLog.state = "sent";
        alertLog.sentAt = new Date();
        alertLog.providerMessageId = messageId;
        alertLog.leaseUntil = null;
        await alertLog.save();
        await Occurrence.updateOne({ _id: occ._id, caregiverAlertState: "queued" }, {
          $set: { caregiverAlertSentAt: alertLog.sentAt, caregiverAlertState: "sent" },
        });
      } catch (innerErr) {
        const diagnostic = providerDiagnostic(alertLog.channel, innerErr);
        console.error("[Worker] Provider delivery failed:", {
          alertId: alertLog._id.toString(),
          attempt: alertLog.attempts,
          ...diagnostic,
        });
        alertLog.lastErrorSummary = diagnostic.summary;
        alertLog.leaseUntil = null;
        if (alertLog.attempts >= alertLog.maxAttempts) {
          alertLog.state = "failed";
          await Occurrence.updateOne({ _id: alertLog.occurrenceId, caregiverAlertState: "queued" }, {
            $set: { caregiverAlertState: "failed" },
          });
        } else {
          alertLog.state = "queued";
          alertLog.nextAttemptAt = new Date(Date.now() + alertLog.attempts * 2 * 60_000);
        }
        await alertLog.save().catch(() => {});
      }
    }
  } catch (err) {
    console.error("[Worker] Error sending queued alerts:", err.message);
  }
}

/**
 * Task 4 (daily at midnight): Generate occurrences for daily reminders
 * so the rolling 7-day window always has upcoming occurrences.
 */
async function generateDailyOccurrences() {
  try {
    const activeDaily = await Medication.find({
      repeating: true,
      $or: [
        { status: "active" },
        { status: { $exists: false }, isActive: { $ne: false } },
      ],
    });
    let generated = 0;
    for (const med of activeDaily) {
      const dates = buildOccurrenceDates(med, new Date(), 14);
      for (const dueAt of dates) {
        const result = await Occurrence.updateOne(
          { reminderId: med._id, scheduledFor: dueAt },
          { $setOnInsert: { reminderId: med._id, userId: med.userId, scheduledFor: dueAt, timezone: med.timezone || "UTC", state: "due" } },
          { upsert: true }
        );
        if (result.upsertedCount > 0) generated++;
      }
    }
    if (generated > 0) {
      console.log(`[Worker] Generated ${generated} daily occurrence(s).`);
    }
  } catch (err) {
    console.error("[Worker] Error generating daily occurrences:", err.message);
  }
}

// ─── Schedule tasks ───────────────────────────────────────────────────────────
// Wait for DB connection before starting cron jobs
mongoose.connection.once("open", () => {
  console.log("[Worker] Starting cron jobs…");
  let scanRunning = false;

  // Every minute: mark overdue, queue alerts, send queued alerts
  cron.schedule("* * * * *", async () => {
    if (scanRunning) return;
    scanRunning = true;
    try {
      await markOverdueOccurrences();
      await queueCaregiverAlerts();
      await sendQueuedAlerts();
    } finally {
      scanRunning = false;
    }
  });

  // Daily at midnight UTC: generate occurrences for next 7 days
  cron.schedule("0 0 * * *", async () => {
    await generateDailyOccurrences();
  });

  // Run the daily generation immediately on startup to fill in any gaps
  generateDailyOccurrences();

  console.log("[Worker] Cron jobs scheduled.");
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdownWorker(signal) {
  console.log(`[Worker] Received ${signal}. Shutting down…`);
  mongoose.connection.close().then(() => {
    console.log("[Worker] Database connection closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGTERM", () => shutdownWorker("SIGTERM"));
process.on("SIGINT", () => shutdownWorker("SIGINT"));

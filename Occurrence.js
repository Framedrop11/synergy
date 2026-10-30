const mongoose = require("mongoose");

/**
 * Occurrence — one expected dose event per document.
 *
 * An Occurrence is generated server-side for each scheduled dose:
 *   - For one-time reminders: one occurrence at the scheduled time.
 *   - For daily reminders: one occurrence per day, generated in advance
 *     (e.g., 7 days ahead) by the occurrence generator worker.
 *
 * Occurrence states:
 *   "due"           — scheduled time is in the future or just passed, no action recorded
 *   "taken"         — patient self-reported as taken
 *   "skipped"       — patient explicitly marked as skipped
 *   "unconfirmed"   — scheduled time has passed without any patient action
 *                     (used after the unconfirmed window, e.g., 24h post-due)
 *   "cancelled"     — the reminder was paused, deleted, or edited before this due time;
 *                     this occurrence no longer applies
 *
 * IMPORTANT: Do not label "unconfirmed" as "missed." The app records self-reported
 * actions only. Absence of a "taken" action does not prove the dose was missed.
 *
 * Idempotency: The (reminderId, scheduledFor) pair is unique. Duplicate action
 * submissions must be detected by checking the occurrence ID + a client-provided
 * idempotency key.
 */
const occurrenceSchema = new mongoose.Schema(
  {
    // The reminder this occurrence belongs to.
    reminderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MedicationInfo",
      required: true,
      index: true,
    },
    // The owner patient, denormalized for efficient ownership checks.
    userId: {
      type: String,
      required: true,
      index: true,
    },
    // UTC timestamp of when this dose was scheduled.
    scheduledFor: {
      type: Date,
      required: true,
      index: true,
    },
    // IANA time-zone identifier at the time this occurrence was generated.
    // Preserved even if the reminder's timezone is later changed.
    timezone: {
      type: String,
      required: true,
      default: "UTC",
    },
    // Current state of this occurrence.
    state: {
      type: String,
      enum: ["due", "taken", "skipped", "unconfirmed", "cancelled"],
      default: "due",
      index: true,
    },
    // When the patient recorded an action (taken or skipped).
    actionAt: {
      type: Date,
      default: null,
    },
    unconfirmedAt: {
      type: Date,
      default: null,
      index: true,
    },
    // Client-supplied idempotency key for action submissions.
    // Prevents duplicate server-side events if the client retries.
    actionIdempotencyKey: {
      type: String,
      default: null,
      sparse: true,
    },
    // Escalation tracking: has the patient follow-up notification been sent?
    followUpSentAt: {
      type: Date,
      default: null,
    },
    // Escalation tracking: has the caregiver alert been sent?
    caregiverAlertSentAt: {
      type: Date,
      default: null,
    },
    // Caregiver alert delivery state
    caregiverAlertState: {
      type: String,
      enum: ["none", "queued", "sent", "failed", "cancelled"],
      default: "none",
    },
    // Note explaining why state was changed (e.g. "reminder deleted", "edited")
    cancellationReason: {
      type: String,
      default: null,
    },
  },
  {
    collection: "Occurrences",
    timestamps: true,
  }
);

// Unique index ensures at most one occurrence per reminder per scheduled time.
// This is the core idempotency guarantee for occurrence generation.
occurrenceSchema.index({ reminderId: 1, scheduledFor: 1 }, { unique: true });

// Index for the worker that scans for due/escalation occurrences.
occurrenceSchema.index({ state: 1, scheduledFor: 1 });

// Index for the weekly summary query (by user + time range).
occurrenceSchema.index({ userId: 1, scheduledFor: 1 });

module.exports = mongoose.model("Occurrence", occurrenceSchema);

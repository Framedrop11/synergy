const mongoose = require("mongoose");

/**
 * AlertLog — one document per caregiver alert attempt.
 *
 * Tracks every caregiver email or SMS alert dispatched by the backend worker,
 * including delivery state, retry history, and provider-assigned message IDs.
 *
 * This is a write-once audit record. State transitions only go forward:
 *   queued → sent (provider accepted)
 *   queued → failed (provider rejected or unreachable)
 *   queued → cancelled (patient took action before alert was sent)
 *
 * "Provider accepted" does not mean the recipient read the message.
 */
const alertLogSchema = new mongoose.Schema(
  {
    // The occurrence that triggered this alert.
    occurrenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Occurrence",
      required: true,
      index: true,
    },
    // The patient who owns the reminder.
    userId: {
      type: String,
      required: true,
      index: true,
    },
    // Alert channel.
    channel: {
      type: String,
      enum: ["email", "sms"],
      required: true,
    },
    kind: {
      type: String,
      enum: ["unconfirmed", "skipped"],
      default: "unconfirmed",
      required: true,
    },
    // Destination (email address or E.164 phone), redacted in logs for privacy.
    // Stored here for deduplication; not included in application logs.
    destination: {
      type: String,
      required: true,
    },
    // Current delivery state.
    state: {
      type: String,
      enum: ["queued", "sending", "sent", "failed", "cancelled"],
      default: "queued",
      index: true,
    },
    // Provider-assigned message ID for deduplication and status lookup.
    providerMessageId: {
      type: String,
      default: null,
    },
    // Deduplication key used with the provider (prevents duplicate sends on retry).
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },
    // Number of send attempts made.
    attempts: {
      type: Number,
      default: 0,
    },
    // Maximum attempts allowed before marking failed.
    maxAttempts: {
      type: Number,
      default: 3,
    },
    // Timestamp of the most recent attempt.
    lastAttemptAt: {
      type: Date,
      default: null,
    },
    nextAttemptAt: {
      type: Date,
      default: null,
      index: true,
    },
    leaseUntil: {
      type: Date,
      default: null,
    },
    // Timestamp when the alert was accepted by the provider.
    sentAt: {
      type: Date,
      default: null,
    },
    // Error detail from the most recent failed attempt (no PII, no credentials).
    lastErrorSummary: {
      type: String,
      default: null,
      maxlength: 500,
    },
    // If cancelled, why.
    cancellationReason: {
      type: String,
      default: null,
    },
  },
  {
    collection: "AlertLog",
    timestamps: true,
  }
);

// Index for the worker polling for queued alerts to retry.
alertLogSchema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });

// Index for per-occurrence deduplication (one alert per occurrence per channel).
alertLogSchema.index({ occurrenceId: 1, channel: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model("AlertLog", alertLogSchema);

const mongoose = require("mongoose");

// Lightweight log for create / edit / delete / taken / skipped actions
// and token-validity check events on protected requests.
const activityLogSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    medicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MedicationInfo",
      default: null,
    },
    // action values: "create" | "edit" | "delete" | "taken" | "skipped" | "auth_check"
    action: {
      type: String,
      required: true,
      enum: ["create", "edit", "delete", "taken", "skipped", "auth_check"],
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    // Optional extra context (e.g. for auth_check: "valid" or "rejected")
    meta: {
      type: String,
      default: null,
    },
  },
  {
    collection: "ActivityLog",
  }
);

module.exports = mongoose.model("ActivityLog", activityLogSchema);

const mongoose = require("mongoose");

/**
 * MedicationInfo — one reminder per document.
 *
 * Schema additions (backward-compatible; all new fields have safe defaults):
 *   - dosage:   Optional free-text string supplied by the patient (e.g. "1 tablet", "5 ml").
 *               The AI may transcribe dosage only when the patient explicitly provides it.
 *               It must not infer, calculate, recommend, or correct a dose.
 *   - timezone: IANA time-zone identifier (e.g. "Asia/Kolkata") in which the reminder time
 *               was scheduled. Stored separately from the UTC timestamp so daily recurrence
 *               can be interpreted in the correct local time across DST transitions.
 *   - status:   "active" | "paused" | "deleted" — replaces the boolean isActive.
 *               "deleted" is a soft-delete; records are excluded from queries but preserved
 *               for audit/history. isActive is kept for backward compatibility.
 */
const medicationSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: [true, "userId is required"],
      index: true,
    },
    medicationName: {
      type: String,
      required: [true, "Medication name is required"],
      trim: true,
      maxlength: [100, "Medication name must be 100 characters or fewer"],
    },
    // Optional dosage as stated by the patient (e.g. "1 tablet", "500 mg").
    // Never required. Never inferred or modified by AI.
    dosage: {
      type: String,
      default: null,
      trim: true,
      maxlength: [80, "Dosage text must be 80 characters or fewer"],
    },
    time: {
      type: Date,
      required: [true, "Time is required"],
    },
    // IANA time-zone identifier for the reminder's scheduled local time.
    // Defaults to UTC when not supplied (for backward compatibility with existing records).
    timezone: {
      type: String,
      default: "UTC",
      maxlength: [64, "Timezone identifier must be 64 characters or fewer"],
    },
    // Soft-delete / pause state. Replaces the boolean isActive for new records.
    // "active"  — reminder is active and schedules occurrences
    // "paused"  — reminder is suspended; future occurrences are not generated
    // "deleted" — soft-deleted; excluded from normal queries; history preserved
    status: {
      type: String,
      enum: ["active", "paused", "deleted"],
      default: "active",
      index: true,
    },
    // Keep isActive for backward compatibility with existing mobile clients.
    // It mirrors status: active <-> true, anything else <-> false.
    isActive: {
      type: Boolean,
      default: true,
    },
    repeating: {
      type: Boolean,
      default: false,
    },
    // OS-returned notification identifier so we can skip re-scheduling.
    notificationId: {
      type: String,
      default: null,
    },
  },
  {
    collection: "MedicationInfo",
    timestamps: true,
  }
);

// Keep isActive and status in sync before saving.
medicationSchema.pre("save", function (next) {
  this.isActive = this.status === "active";
  next();
});

module.exports = mongoose.model("MedicationInfo", medicationSchema);
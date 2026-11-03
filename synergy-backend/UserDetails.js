const mongoose = require("mongoose");

/**
 * UserInfo — one document per registered patient.
 *
 * Schema additions (all backward-compatible with safe defaults):
 *   - caregiver: Optional sub-document for the patient-configured alert recipient.
 *       The caregiver has no account, no dashboard, and no portal in this product.
 *       This stores only the contact information and verification state for
 *       one-way alert delivery (email or SMS) authorized by the patient.
 *   - alertSettings: Patient-configurable timing for the escalation sequence.
 */
const userDetailsSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      minlength: [3, "Name must be at least 3 characters long"],
      maxlength: [100, "Name must be 100 characters or fewer"],
    },
    phone: {
      type: String,
      required: false,
      validate: {
        validator: function (v) {
          if (v == null || v === "") return true;
          return /^\d{10}$/.test(v);
        },
        message: (props) => `${props.value} is not a valid phone number!`,
      },
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      validate: {
        validator: function (v) {
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        },
        message: (props) => `${props.value} is not a valid email address!`,
      },
    },
    password: {
      type: String,
      required: false,
      minlength: [6, "Password must be at least 6 characters long"],
    },
    googleId: {
      type: String,
      sparse: true,
      unique: true,
    },
    // ── Caregiver alert recipient ──────────────────────────────────────────────
    // The patient configures a single optional recipient (email or phone) who
    // receives a simple notification when a dose occurrence is unconfirmed past
    // the configured threshold. The caregiver has no account or portal.
    caregiver: {
      // Contact channel: "email" | "sms" | null (not configured)
      channel: {
        type: String,
        enum: ["email", "sms", null],
        default: null,
      },
      // Destination: email address or E.164 phone number
      destination: {
        type: String,
        default: null,
        maxlength: [200, "Destination must be 200 characters or fewer"],
      },
      // Whether the destination has been verified (clicked verification link / replied to SMS)
      verified: {
        type: Boolean,
        default: false,
      },
      // Short token sent to the destination during verification
      verificationTokenHash: {
        type: String,
        default: null,
      },
      verificationTokenExpiresAt: {
        type: Date,
        default: null,
      },
      consentVersion: {
        type: String,
        default: null,
      },
      preferredLanguage: {
        type: String,
        enum: ["en", "hi"],
        default: "en",
      },
      // Whether the patient has enabled caregiver alerts (requires verified=true)
      alertsEnabled: {
        type: Boolean,
        default: false,
      },
      // Whether the recipient has opted out of future alerts
      recipientOptedOut: {
        type: Boolean,
        default: false,
      },
    },
    // ── Alert timing settings (patient-configurable) ────────────────────────
    alertSettings: {
      // Minutes after scheduled dose time to send patient follow-up reminder
      // Valid range: 5–120 minutes. Default: 30.
      followUpMinutes: {
        type: Number,
        default: 30,
        min: [5, "Follow-up delay must be at least 5 minutes"],
        max: [120, "Follow-up delay must be at most 120 minutes"],
      },
      // Minutes after scheduled dose time to send caregiver alert
      // Valid range: followUpMinutes+1 to 180 minutes. Default: 45.
      caregiverAlertMinutes: {
        type: Number,
        default: 45,
        min: [6, "Caregiver alert delay must be at least 6 minutes"],
        max: [180, "Caregiver alert delay must be at most 180 minutes"],
      },
      // Whether to send a caregiver alert when the patient explicitly marks a dose Skipped
      alertOnSkipped: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    collection: "UserInfo",
  }
);

module.exports = mongoose.model("UserInfo", userDetailsSchema);

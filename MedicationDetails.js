const mongoose = require("mongoose");

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
    },
    time: {
      type: Date,
      required: [true, "Time is required"],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    repeating: {
      type: Boolean,
      default: false,
    },
    // Stores the OS-returned notification identifier so we can
    // skip re-scheduling if a trigger is already registered.
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

module.exports = mongoose.model("MedicationInfo", medicationSchema);
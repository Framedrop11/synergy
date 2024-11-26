const mongoose = require("mongoose");

const medicationSchema = new mongoose.Schema(
  {
    medicationName: {
      type: String,
      required: [true, "Medication name is required"],
      trim: true
    },
    time: {
      type: String, // or Date if you prefer
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    repeating: {
      type: Boolean,
      default: false  // This field will indicate whether the reminder repeats
    },
  },
  {
    collection: "MedicationInfo",
  }
);

module.exports = mongoose.model("MedicationInfo", medicationSchema);
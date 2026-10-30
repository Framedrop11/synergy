const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  hits: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
}, { collection: "RateLimitCounters" });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RateLimitCounter || mongoose.model("RateLimitCounter", schema);

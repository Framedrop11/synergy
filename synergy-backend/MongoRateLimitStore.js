const Counter = require("./RateLimitCounter");

/** Shared, database-backed express-rate-limit store for multi-instance API deployments. */
class MongoRateLimitStore {
  constructor(namespace) {
    this.prefix = `${namespace}:`;
    this.windowMs = 15 * 60 * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const now = new Date();
    const id = this.prefix + key;
    const counter = await Counter.findOneAndUpdate(
      { key: id, expiresAt: { $gt: now } },
      { $inc: { hits: 1 } },
      { new: true }
    ).lean();
    if (counter) return { totalHits: counter.hits, resetTime: counter.expiresAt };

    try {
      const created = await Counter.findOneAndUpdate(
        { key: id },
        { $set: { hits: 1, expiresAt: new Date(now.getTime() + this.windowMs) } },
        { upsert: true, new: true }
      ).lean();
      return { totalHits: created.hits, resetTime: created.expiresAt };
    } catch (error) {
      if (error.code !== 11000) throw error;
      return this.increment(key);
    }
  }

  async decrement(key) {
    await Counter.updateOne({ key: this.prefix + key, hits: { $gt: 0 } }, { $inc: { hits: -1 } });
  }

  async resetKey(key) {
    await Counter.deleteOne({ key: this.prefix + key });
  }
}

module.exports = MongoRateLimitStore;

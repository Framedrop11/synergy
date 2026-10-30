const test = require("node:test");
const assert = require("node:assert/strict");

const baseUrl = (process.env.API_BASE_URL || "").replace(/\/$/, "");
const options = { skip: !baseUrl && "Set API_BASE_URL to the running deployment to execute API smoke tests." };

test("deployed API health reports a connected database", options, async () => {
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.db, "connected");
});

test("patient reminder endpoint rejects unauthenticated requests", options, async () => {
  const response = await fetch(`${baseUrl}/getReminders`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 401);
});

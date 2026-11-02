const nodemailer = require("nodemailer");

let emailTransporter = null;
function getEmailTransporter() {
  if (emailTransporter) return emailTransporter;
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  emailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return emailTransporter;
}

function isChannelConfigured(channel) {
  if (channel === "email") return Boolean(getEmailTransporter() && process.env.EMAIL_FROM);
  if (channel === "sms") return Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER
  );
  return false;
}

/**
 * Return provider diagnostics without exposing SMTP responses, credentials, or
 * recipient addresses. Provider codes are safe and actionable in server logs.
 */
function providerDiagnostic(channel, error) {
  const details = { channel, code: null, status: null, command: null };
  if (error?.providerCode !== undefined && error.providerCode !== null) {
    details.code = String(error.providerCode).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || null;
  } else if (error?.code !== undefined && error.code !== null) {
    details.code = String(error.code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || null;
  }
  const status = error?.providerStatus ?? error?.responseCode;
  if (Number.isInteger(Number(status)) && Number(status) > 0) details.status = Number(status);
  if (typeof error?.command === "string") {
    details.command = error.command.replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 32) || null;
  }
  details.summary = [
    `${String(channel || "message").toUpperCase()} delivery failed`,
    details.code ? `code=${details.code}` : null,
    details.status ? `status=${details.status}` : null,
    details.command ? `command=${details.command}` : null,
  ].filter(Boolean).join("; ");
  return details;
}

async function sendEmail({ to, subject, text, unsubscribeUrl }) {
  const transporter = getEmailTransporter();
  if (!transporter || !process.env.EMAIL_FROM) throw new Error("Email delivery is not configured");
  const options = { from: process.env.EMAIL_FROM, to, subject, text };
  if (unsubscribeUrl) options.headers = { "List-Unsubscribe": `<${unsubscribeUrl}>` };
  const result = await transporter.sendMail(options);
  return { messageId: result.messageId || null };
}

async function sendSms({ to, text }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) throw new Error("SMS delivery is not configured");

  const smsText = /reply\s+stop/i.test(text) ? text : `${text}\nReply STOP to opt out.`;
  const body = new URLSearchParams({ To: to, From: from, Body: smsText });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`SMS provider rejected the request (${response.status})`);
    error.providerCode = payload.code || null;
    error.providerStatus = response.status;
    throw error;
  }
  return { messageId: payload.sid || null };
}

module.exports = { isChannelConfigured, sendEmail, sendSms, providerDiagnostic };

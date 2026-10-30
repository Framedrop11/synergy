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
    throw error;
  }
  return { messageId: payload.sid || null };
}

module.exports = { isChannelConfigured, sendEmail, sendSms };

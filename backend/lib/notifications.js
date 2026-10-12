'use strict';

const API_URL = 'https://api.resend.com/emails';

function isConfigured(businessEmail = '') {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && (process.env.NOTIFICATION_EMAIL_TO || businessEmail));
}

async function sendEmail({ to, subject, text }) {
  if (!to || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    return { sent: false, skipped: true, reason: 'Email notifications are not configured.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject: String(subject).slice(0, 180), text: String(text).slice(0, 10_000) }),
      signal: controller.signal
    });
    const responseText = await response.text();
    if (!response.ok) {
      console.warn(`Email provider returned HTTP ${response.status}; notification was not sent.`);
      return { sent: false, skipped: false, reason: `Email provider returned HTTP ${response.status}.` };
    }
    return { sent: true, skipped: false, providerResponse: responseText.slice(0, 1000) };
  } catch (error) {
    console.warn(`Email notification failed: ${error.name === 'AbortError' ? 'request timed out' : error.message}`);
    return { sent: false, skipped: false, reason: error.name === 'AbortError' ? 'Email request timed out.' : 'Email provider request failed.' };
  } finally {
    clearTimeout(timer);
  }
}

function adminRecipient(settings = {}) {
  return process.env.NOTIFICATION_EMAIL_TO || settings.email || '';
}

module.exports = { isConfigured, sendEmail, adminRecipient };

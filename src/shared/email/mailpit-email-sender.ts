import { EMAIL_REQUEST_TIMEOUT_IN_MS } from './email-sender.js';
import type { EmailFrom, EmailSender } from './email-sender.js';

export function createMailpitEmailSender(baseUrl: string, from: EmailFrom): EmailSender {
  return {
    async send({ to, subject, html, text }) {
      const response = await fetch(new URL('/api/v1/send', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          From: { Name: from.name, Email: from.address },
          To: [{ Email: to }],
          Subject: subject,
          HTML: html,
          Text: text,
        }),
        signal: AbortSignal.timeout(EMAIL_REQUEST_TIMEOUT_IN_MS),
      });

      if (!response.ok) {
        throw new Error(`Mailpit rejected the email with status ${response.status}.`);
      }
    },
  };
}

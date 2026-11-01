import { EMAIL_REQUEST_TIMEOUT_IN_MS } from './email-sender.js';
import type { EmailFrom, EmailSender } from './email-sender.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

export function createResendEmailSender(apiKey: string, from: EmailFrom): EmailSender {
  return {
    async send({ to, subject, html, text }) {
      const response = await fetch(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          from: `${from.name} <${from.address}>`,
          to: [to],
          subject,
          html,
          text,
        }),
        signal: AbortSignal.timeout(EMAIL_REQUEST_TIMEOUT_IN_MS),
      });

      if (!response.ok) {
        throw new Error(`Resend rejected the email with status ${response.status}.`);
      }
    },
  };
}

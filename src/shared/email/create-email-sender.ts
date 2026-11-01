import type { Env } from '../../config/env.js';
import type { EmailSender } from './email-sender.js';
import { createMailpitEmailSender } from './mailpit-email-sender.js';
import { createResendEmailSender } from './resend-email-sender.js';

export function createEmailSender(env: Env): EmailSender {
  const from = { name: env.EMAIL_FROM_NAME, address: env.EMAIL_FROM_ADDRESS };
  return env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY
    ? createResendEmailSender(env.RESEND_API_KEY, from)
    : createMailpitEmailSender(env.MAILPIT_URL, from);
}

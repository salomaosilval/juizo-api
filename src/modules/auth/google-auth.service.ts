import { z } from 'zod';
import type { EmailSender } from '../../shared/email/email-sender.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { BackgroundTasks } from '../../shared/tasks/background-tasks.js';
import type { Clock } from '../../shared/time/clock.js';
import { clientAttemptKey, emailAttemptKey } from './attempt-limiter.js';
import type { AttemptLimiter } from './attempt-limiter.js';
import { buildGoogleLinkedEmail, buildGoogleSignupLinkEmail } from './auth-emails.js';
import type { UserRecord } from './auth.repository.js';
import { currentConsentVersions } from './consent-versions.js';
import type { GoogleAuthRepository } from './google-auth.repository.js';
import type { GoogleProfile } from './google-identity-provider.js';
import { generateSecretToken, hashSecret } from './secret-token.js';

const MINUTE_IN_MS = 60_000;
const SIGNUP_LINK_LIFETIME_IN_MS = 30 * MINUTE_IN_MS;
const COMPLETE_ACTION = 'google-signup-complete';
const COMPLETE_LIMIT_BY_CLIENT = { maxAttempts: 10, windowInMs: 15 * MINUTE_IN_MS };
const SIGNUP_EMAIL_ACTION = 'google-signup-email';
const SIGNUP_EMAIL_LIMIT = { maxAttempts: 3, windowInMs: 60 * MINUTE_IN_MS };
const emailSchema = z.email();

export type GoogleSignInResult =
  | { outcome: 'signed_in'; user: UserRecord }
  | { outcome: 'signup_required'; token: string }
  | { outcome: 'mailbox_confirmation_required' }
  | { outcome: 'password_required' }
  | { outcome: 'rejected' };

export interface GoogleSignupCompletionInput {
  token: string;
  name: string;
  hasAcceptedTerms: true;
  hasConsentedToAiDataProcessing: boolean;
  clientIp: string;
}

export interface GoogleAuthService {
  signIn(profile: GoogleProfile): Promise<GoogleSignInResult>;
  findSignupDetails(token: string): Promise<{ email: string; name: string }>;
  completeSignup(input: GoogleSignupCompletionInput): Promise<UserRecord>;
}

interface GoogleAuthServiceDependencies {
  repository: GoogleAuthRepository;
  attemptLimiter: AttemptLimiter;
  emailSender: EmailSender;
  backgroundTasks: BackgroundTasks;
  clock: Clock;
  webAppUrl: string;
}

export function createGoogleAuthService({
  repository,
  attemptLimiter,
  emailSender,
  backgroundTasks,
  clock,
  webAppUrl,
}: GoogleAuthServiceDependencies): GoogleAuthService {
  function invalidToken(): AppError {
    return new AppError('INVALID_TOKEN', 'This link is invalid or has expired.');
  }

  return {
    async signIn({
      subject,
      email: providedEmail,
      isEmailVerified,
      isGoogleAuthoritativeForEmail,
      name,
    }) {
      const linkedUser = await repository.findUserByIdentity(subject);
      if (linkedUser) {
        return { outcome: 'signed_in', user: linkedUser };
      }

      const email = providedEmail.trim().toLowerCase();
      if (!isEmailVerified || !emailSchema.safeParse(email).success) {
        return { outcome: 'rejected' };
      }

      const existingUser = await repository.findUserByEmail(email);
      if (existingUser) {
        if (!isGoogleAuthoritativeForEmail) {
          return { outcome: 'password_required' };
        }
        if ((await repository.linkIdentity(existingUser.id, subject)) === 'conflict') {
          return { outcome: 'rejected' };
        }
        backgroundTasks.run('notify google link', () =>
          emailSender.send(buildGoogleLinkedEmail(email, webAppUrl)),
        );
        return { outcome: 'signed_in', user: existingUser };
      }

      const now = clock.now();
      await repository.deleteExpiredSignupTokens(now);
      const token = generateSecretToken();
      await repository.createSignupToken({
        tokenHash: hashSecret(token),
        subject,
        email,
        name,
        expiresAt: new Date(now.getTime() + SIGNUP_LINK_LIFETIME_IN_MS),
      });
      if (isGoogleAuthoritativeForEmail) {
        return { outcome: 'signup_required', token };
      }

      backgroundTasks.run('send google signup link', async () => {
        const key = emailAttemptKey(SIGNUP_EMAIL_ACTION, email);
        if (!(await attemptLimiter.exceeds(key, SIGNUP_EMAIL_LIMIT))) {
          await emailSender.send(buildGoogleSignupLinkEmail(email, webAppUrl, token));
        }
      });
      return { outcome: 'mailbox_confirmation_required' };
    },

    async findSignupDetails(token) {
      const details = await repository.findValidSignupToken(hashSecret(token), clock.now());
      if (!details) {
        throw invalidToken();
      }
      return details;
    },

    async completeSignup({ token, name, hasConsentedToAiDataProcessing, clientIp }) {
      if (
        await attemptLimiter.exceeds(
          clientAttemptKey(COMPLETE_ACTION, clientIp),
          COMPLETE_LIMIT_BY_CLIENT,
        )
      ) {
        throw new AppError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
      }

      const user = await repository.completeSignup({
        tokenHash: hashSecret(token),
        name,
        now: clock.now(),
        ...currentConsentVersions(hasConsentedToAiDataProcessing),
      });
      if (!user) {
        throw invalidToken();
      }
      return user;
    },
  };
}

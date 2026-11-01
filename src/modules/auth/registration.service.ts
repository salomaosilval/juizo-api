import type { EmailSender } from '../../shared/email/email-sender.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { BackgroundTasks } from '../../shared/tasks/background-tasks.js';
import type { Clock } from '../../shared/time/clock.js';
import { clientAttemptKey, emailAndClientAttemptKey, emailAttemptKey } from './attempt-limiter.js';
import type { AttemptLimiter } from './attempt-limiter.js';
import { buildAccountAlreadyExistsEmail, buildEmailVerificationEmail } from './auth-emails.js';
import type { PasswordHasher } from './password-hasher.js';
import type { RegistrationRepository } from './registration.repository.js';
import { generateSecretToken, hashSecret } from './secret-token.js';

const CURRENT_TERMS_VERSION = '1';
const CURRENT_AI_DATA_PROCESSING_VERSION = '1';

const HOUR_IN_MS = 3_600_000;
const VERIFICATION_LINK_LIFETIME_IN_MS = 24 * HOUR_IN_MS;

const REGISTRATION_ACTION = 'registration';
const VERIFICATION_RESEND_ACTION = 'verification-resend';
const VERIFICATION_EMAIL_ACTION = 'verification-email';

const LIMIT_BY_CLIENT = { maxAttempts: 10, windowInMs: HOUR_IN_MS };
const EMAILS_PER_ADDRESS_AND_CLIENT_LIMIT = { maxAttempts: 3, windowInMs: HOUR_IN_MS };
const EMAILS_PER_ADDRESS_LIMIT = { maxAttempts: 10, windowInMs: HOUR_IN_MS };

export interface RegistrationInput {
  name: string;
  email: string;
  password: string;
  hasAcceptedTerms: true;
  hasConsentedToAiDataProcessing: boolean;
  clientIp: string;
}

export interface RegistrationService {
  register(input: RegistrationInput): Promise<void>;
  resendVerification(email: string, clientIp: string): Promise<void>;
  confirmEmail(token: string): Promise<void>;
}

interface RegistrationServiceDependencies {
  repository: RegistrationRepository;
  attemptLimiter: AttemptLimiter;
  passwordHasher: PasswordHasher;
  emailSender: EmailSender;
  backgroundTasks: BackgroundTasks;
  clock: Clock;
  webAppUrl: string;
}

export function createRegistrationService({
  repository,
  attemptLimiter,
  passwordHasher,
  emailSender,
  backgroundTasks,
  clock,
  webAppUrl,
}: RegistrationServiceDependencies): RegistrationService {
  async function rejectIfClientIsLimited(action: string, clientIp: string): Promise<void> {
    if (await attemptLimiter.exceeds(clientAttemptKey(action, clientIp), LIMIT_BY_CLIENT)) {
      throw new AppError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
    }
  }

  async function exceedsEmailLimits(email: string, clientIp: string): Promise<boolean> {
    return (
      (await attemptLimiter.exceeds(
        emailAndClientAttemptKey(VERIFICATION_EMAIL_ACTION, email, clientIp),
        EMAILS_PER_ADDRESS_AND_CLIENT_LIMIT,
      )) ||
      (await attemptLimiter.exceeds(
        emailAttemptKey(VERIFICATION_EMAIL_ACTION, email),
        EMAILS_PER_ADDRESS_LIMIT,
      ))
    );
  }

  return {
    async register({ name, email, password, hasConsentedToAiDataProcessing, clientIp }) {
      await rejectIfClientIsLimited(REGISTRATION_ACTION, clientIp);
      const passwordHash = await passwordHasher.hash(password);

      backgroundTasks.run('complete registration request', async () => {
        if (await exceedsEmailLimits(email, clientIp)) {
          return;
        }

        const now = clock.now();
        await repository.deleteExpiredPendingRegistrations(now);

        if (await repository.userExists(email)) {
          await emailSender.send(buildAccountAlreadyExistsEmail(email, webAppUrl));
          return;
        }

        const token = generateSecretToken();
        await repository.createPendingRegistration({
          tokenHash: hashSecret(token),
          email,
          name,
          passwordHash,
          termsVersion: CURRENT_TERMS_VERSION,
          aiDataProcessingVersion: hasConsentedToAiDataProcessing
            ? CURRENT_AI_DATA_PROCESSING_VERSION
            : null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + VERIFICATION_LINK_LIFETIME_IN_MS),
        });
        await emailSender.send(buildEmailVerificationEmail(email, webAppUrl, token));
      });
    },

    async resendVerification(email, clientIp) {
      await rejectIfClientIsLimited(VERIFICATION_RESEND_ACTION, clientIp);

      backgroundTasks.run('resend email verification', async () => {
        if (await exceedsEmailLimits(email, clientIp)) {
          return;
        }

        const now = clock.now();
        const token = generateSecretToken();
        const hasPendingRegistration = await repository.rotateLatestPendingToken(
          email,
          hashSecret(token),
          new Date(now.getTime() + VERIFICATION_LINK_LIFETIME_IN_MS),
          now,
        );
        if (hasPendingRegistration) {
          await emailSender.send(buildEmailVerificationEmail(email, webAppUrl, token));
        }
      });
    },

    async confirmEmail(token) {
      const result = await repository.completeRegistration(hashSecret(token), clock.now());
      if (result === 'invalid_token') {
        throw new AppError('INVALID_TOKEN', 'This link is invalid or has expired.');
      }
    },
  };
}

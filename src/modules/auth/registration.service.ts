import type { EmailSender } from '../../shared/email/email-sender.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { BackgroundTasks } from '../../shared/tasks/background-tasks.js';
import type { Clock } from '../../shared/time/clock.js';
import { clientAttemptKey, emailAndClientAttemptKey, emailAttemptKey } from './attempt-limiter.js';
import type { AttemptLimiter } from './attempt-limiter.js';
import { buildAccountAlreadyExistsEmail, buildRegistrationLinkEmail } from './auth-emails.js';
import type { UserRecord } from './auth.repository.js';
import type { PasswordHasher } from './password-hasher.js';
import type { RegistrationRepository } from './registration.repository.js';
import { generateSecretToken, hashSecret } from './secret-token.js';

const CURRENT_TERMS_VERSION = '1';
const CURRENT_AI_DATA_PROCESSING_VERSION = '1';

const MINUTE_IN_MS = 60_000;
const HOUR_IN_MS = 60 * MINUTE_IN_MS;
const REGISTRATION_LINK_LIFETIME_IN_MS = 24 * HOUR_IN_MS;

const START_ACTION = 'registration-start';
const COMPLETE_ACTION = 'registration-complete';

const START_LIMIT_BY_CLIENT = { maxAttempts: 10, windowInMs: HOUR_IN_MS };
const START_LIMIT_BY_EMAIL_AND_CLIENT = { maxAttempts: 3, windowInMs: HOUR_IN_MS };
const START_LIMIT_BY_EMAIL = { maxAttempts: 10, windowInMs: HOUR_IN_MS };
const COMPLETE_LIMIT_BY_CLIENT = { maxAttempts: 10, windowInMs: 15 * MINUTE_IN_MS };

export interface RegistrationCompletion {
  token: string;
  name: string;
  password: string;
  hasAcceptedTerms: true;
  hasConsentedToAiDataProcessing: boolean;
  clientIp: string;
}

export interface RegistrationService {
  start(email: string, clientIp: string): Promise<void>;
  findEmailForToken(token: string): Promise<string>;
  complete(completion: RegistrationCompletion): Promise<UserRecord>;
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
  function invalidToken(): AppError {
    return new AppError('INVALID_TOKEN', 'This link is invalid or has expired.');
  }

  function tooManyAttempts(): AppError {
    return new AppError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
  }

  async function exceedsEmailLimits(email: string, clientIp: string): Promise<boolean> {
    return (
      (await attemptLimiter.exceeds(
        emailAndClientAttemptKey(START_ACTION, email, clientIp),
        START_LIMIT_BY_EMAIL_AND_CLIENT,
      )) ||
      (await attemptLimiter.exceeds(emailAttemptKey(START_ACTION, email), START_LIMIT_BY_EMAIL))
    );
  }

  return {
    async start(email, clientIp) {
      if (
        await attemptLimiter.exceeds(
          clientAttemptKey(START_ACTION, clientIp),
          START_LIMIT_BY_CLIENT,
        )
      ) {
        throw tooManyAttempts();
      }

      backgroundTasks.run('start registration', async () => {
        if (await exceedsEmailLimits(email, clientIp)) {
          return;
        }

        const now = clock.now();
        await repository.deleteExpiredTokens(now);

        if (await repository.userExists(email)) {
          await emailSender.send(buildAccountAlreadyExistsEmail(email, webAppUrl));
          return;
        }

        const token = generateSecretToken();
        await repository.createToken({
          tokenHash: hashSecret(token),
          email,
          expiresAt: new Date(now.getTime() + REGISTRATION_LINK_LIFETIME_IN_MS),
        });
        await emailSender.send(buildRegistrationLinkEmail(email, webAppUrl, token));
      });
    },

    async findEmailForToken(token) {
      const email = await repository.findEmailByValidToken(hashSecret(token), clock.now());
      if (email === null) {
        throw invalidToken();
      }
      return email;
    },

    async complete({ token, name, password, hasConsentedToAiDataProcessing, clientIp }) {
      if (
        await attemptLimiter.exceeds(
          clientAttemptKey(COMPLETE_ACTION, clientIp),
          COMPLETE_LIMIT_BY_CLIENT,
        )
      ) {
        throw tooManyAttempts();
      }

      const tokenHash = hashSecret(token);
      if ((await repository.findEmailByValidToken(tokenHash, clock.now())) === null) {
        throw invalidToken();
      }

      const user = await repository.completeRegistration({
        tokenHash,
        name,
        passwordHash: await passwordHasher.hash(password),
        termsVersion: CURRENT_TERMS_VERSION,
        aiDataProcessingVersion: hasConsentedToAiDataProcessing
          ? CURRENT_AI_DATA_PROCESSING_VERSION
          : null,
        now: clock.now(),
      });
      if (!user) {
        throw invalidToken();
      }
      return user;
    },
  };
}

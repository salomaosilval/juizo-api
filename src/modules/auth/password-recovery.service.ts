import type { EmailSender } from '../../shared/email/email-sender.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { BackgroundTasks } from '../../shared/tasks/background-tasks.js';
import type { Clock } from '../../shared/time/clock.js';
import { clientAttemptKey, emailAndClientAttemptKey, emailAttemptKey } from './attempt-limiter.js';
import type { AttemptLimiter } from './attempt-limiter.js';
import { buildPasswordChangedEmail, buildPasswordResetEmail } from './auth-emails.js';
import { LOGIN_ATTEMPT_ACTION } from './auth.service.js';
import type { PasswordHasher } from './password-hasher.js';
import type { PasswordRecoveryRepository } from './password-recovery.repository.js';
import { generateSecretToken, hashSecret } from './secret-token.js';

const MINUTE_IN_MS = 60_000;
const HOUR_IN_MS = 60 * MINUTE_IN_MS;
const RESET_LINK_LIFETIME_IN_MS = 30 * MINUTE_IN_MS;

const RESET_REQUEST_ACTION = 'password-reset-request';
const RESET_CONFIRM_ACTION = 'password-reset-confirm';

const REQUEST_LIMIT_BY_CLIENT = { maxAttempts: 10, windowInMs: HOUR_IN_MS };
const REQUEST_LIMIT_BY_EMAIL_AND_CLIENT = { maxAttempts: 3, windowInMs: HOUR_IN_MS };
const REQUEST_LIMIT_BY_EMAIL = { maxAttempts: 10, windowInMs: HOUR_IN_MS };
const CONFIRM_LIMIT_BY_CLIENT = { maxAttempts: 10, windowInMs: 15 * MINUTE_IN_MS };

export interface PasswordRecoveryService {
  requestReset(email: string, clientIp: string): Promise<void>;
  resetPassword(token: string, password: string, clientIp: string): Promise<void>;
}

interface PasswordRecoveryServiceDependencies {
  repository: PasswordRecoveryRepository;
  attemptLimiter: AttemptLimiter;
  passwordHasher: PasswordHasher;
  emailSender: EmailSender;
  backgroundTasks: BackgroundTasks;
  clock: Clock;
  webAppUrl: string;
}

export function createPasswordRecoveryService({
  repository,
  attemptLimiter,
  passwordHasher,
  emailSender,
  backgroundTasks,
  clock,
  webAppUrl,
}: PasswordRecoveryServiceDependencies): PasswordRecoveryService {
  function invalidToken(): AppError {
    return new AppError('INVALID_TOKEN', 'This link is invalid or has expired.');
  }

  async function rejectIfClientIsLimited(
    action: string,
    clientIp: string,
    limit: { maxAttempts: number; windowInMs: number },
  ): Promise<void> {
    if (await attemptLimiter.exceeds(clientAttemptKey(action, clientIp), limit)) {
      throw new AppError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
    }
  }

  return {
    async requestReset(email, clientIp) {
      await rejectIfClientIsLimited(RESET_REQUEST_ACTION, clientIp, REQUEST_LIMIT_BY_CLIENT);

      backgroundTasks.run('request password reset', async () => {
        const isLimited =
          (await attemptLimiter.exceeds(
            emailAndClientAttemptKey(RESET_REQUEST_ACTION, email, clientIp),
            REQUEST_LIMIT_BY_EMAIL_AND_CLIENT,
          )) ||
          (await attemptLimiter.exceeds(
            emailAttemptKey(RESET_REQUEST_ACTION, email),
            REQUEST_LIMIT_BY_EMAIL,
          ));
        if (isLimited) {
          return;
        }

        const userId = await repository.findUserIdByEmail(email);
        if (!userId) {
          return;
        }

        const token = generateSecretToken();
        const expiresAt = new Date(clock.now().getTime() + RESET_LINK_LIFETIME_IN_MS);
        await repository.replaceResetToken(userId, hashSecret(token), expiresAt);
        await emailSender.send(buildPasswordResetEmail(email, webAppUrl, token));
      });
    },

    async resetPassword(token, password, clientIp) {
      await rejectIfClientIsLimited(RESET_CONFIRM_ACTION, clientIp, CONFIRM_LIMIT_BY_CLIENT);

      const tokenHash = hashSecret(token);
      if (!(await repository.isResetTokenValid(tokenHash, clock.now()))) {
        throw invalidToken();
      }

      const passwordHash = await passwordHasher.hash(password);
      const email = await repository.resetPassword(tokenHash, passwordHash, clock.now());
      if (email === null) {
        throw invalidToken();
      }

      await attemptLimiter.clear(emailAttemptKey(LOGIN_ATTEMPT_ACTION, email));
      await attemptLimiter.clear(emailAndClientAttemptKey(LOGIN_ATTEMPT_ACTION, email, clientIp));
      backgroundTasks.run('notify password change', () =>
        emailSender.send(buildPasswordChangedEmail(email, webAppUrl)),
      );
    },
  };
}

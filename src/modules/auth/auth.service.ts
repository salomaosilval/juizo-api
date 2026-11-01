import { AppError } from '../../shared/errors/app-error.js';
import type { Clock } from '../../shared/time/clock.js';
import { clientAttemptKey, emailAndClientAttemptKey, emailAttemptKey } from './attempt-limiter.js';
import type { AttemptLimiter } from './attempt-limiter.js';
import type { AuthRepository, UserRecord } from './auth.repository.js';
import type { PasswordHasher } from './password-hasher.js';
import { generateSecretToken, hashSecret } from './secret-token.js';
import { computeSessionExpiry, isSessionExpired, shouldRenewSession } from './session-policy.js';

const MINUTE_IN_MS = 60_000;

const LOGIN_LIMIT_BY_EMAIL_AND_CLIENT = { maxAttempts: 10, windowInMs: 15 * MINUTE_IN_MS };
const LOGIN_LIMIT_BY_EMAIL = { maxAttempts: 100, windowInMs: 15 * MINUTE_IN_MS };
const LOGIN_LIMIT_BY_CLIENT = { maxAttempts: 30, windowInMs: 15 * MINUTE_IN_MS };

export const LOGIN_ATTEMPT_ACTION = 'login';

export interface LoginInput {
  email: string;
  password: string;
  rememberMe: boolean;
  clientIp: string;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export interface Authentication {
  user: UserRecord;
  renewedExpiresAt: Date | null;
}

export interface AuthService {
  login(input: LoginInput): Promise<{ user: UserRecord; session: IssuedSession }>;
  startSession(userId: string): Promise<IssuedSession>;
  logout(token: string): Promise<void>;
  authenticate(token: string): Promise<Authentication>;
}

interface AuthServiceDependencies {
  repository: AuthRepository;
  attemptLimiter: AttemptLimiter;
  passwordHasher: PasswordHasher;
  clock: Clock;
  decoyPasswordHash: string;
}

export function createAuthService({
  repository,
  attemptLimiter,
  passwordHasher,
  clock,
  decoyPasswordHash,
}: AuthServiceDependencies): AuthService {
  return {
    async login({ email, password, rememberMe, clientIp }) {
      const clientKey = clientAttemptKey(LOGIN_ATTEMPT_ACTION, clientIp);
      const emailAndClientKey = emailAndClientAttemptKey(LOGIN_ATTEMPT_ACTION, email, clientIp);
      const emailKey = emailAttemptKey(LOGIN_ATTEMPT_ACTION, email);
      const isLimited =
        (await attemptLimiter.exceeds(clientKey, LOGIN_LIMIT_BY_CLIENT)) ||
        (await attemptLimiter.exceeds(emailAndClientKey, LOGIN_LIMIT_BY_EMAIL_AND_CLIENT)) ||
        (await attemptLimiter.exceeds(emailKey, LOGIN_LIMIT_BY_EMAIL));
      if (isLimited) {
        throw new AppError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
      }

      const credentials = await repository.findCredentialsByEmail(email);
      const isPasswordValid = await passwordHasher.verify(
        password,
        credentials?.passwordHash ?? decoyPasswordHash,
      );
      if (!credentials || !isPasswordValid) {
        throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
      }

      await attemptLimiter.clear(emailAndClientKey);
      await attemptLimiter.refund(emailKey);
      await attemptLimiter.refund(clientKey);

      const token = generateSecretToken();
      const expiresAt = computeSessionExpiry(clock.now(), rememberMe);
      const isSessionCreated = await repository.createSessionIfPasswordUnchanged(
        {
          userId: credentials.id,
          tokenHash: hashSecret(token),
          isPersistent: rememberMe,
          expiresAt,
        },
        credentials.passwordHash,
      );
      if (!isSessionCreated) {
        throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
      }

      return {
        user: { id: credentials.id, name: credentials.name, email: credentials.email },
        session: { token, expiresAt },
      };
    },

    async startSession(userId) {
      const token = generateSecretToken();
      const expiresAt = computeSessionExpiry(clock.now(), false);
      await repository.createSession({
        userId,
        tokenHash: hashSecret(token),
        isPersistent: false,
        expiresAt,
      });
      return { token, expiresAt };
    },

    async logout(token) {
      await repository.deleteSessionByTokenHash(hashSecret(token));
    },

    async authenticate(token) {
      const session = await repository.findSessionByTokenHash(hashSecret(token));
      if (!session) {
        throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
      }

      const now = clock.now();
      if (isSessionExpired(session, now)) {
        await repository.deleteSession(session.id);
        throw new AppError('UNAUTHENTICATED', 'Authentication is required.');
      }

      if (!shouldRenewSession(session, now)) {
        return { user: session.user, renewedExpiresAt: null };
      }

      const renewedExpiresAt = computeSessionExpiry(now, true);
      await repository.renewSession(session.id, renewedExpiresAt);
      return { user: session.user, renewedExpiresAt };
    },
  };
}

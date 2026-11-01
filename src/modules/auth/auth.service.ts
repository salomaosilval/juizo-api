import { AppError } from '../../shared/errors/app-error.js';
import { toClientNetwork } from '../../shared/http/client-network.js';
import type { Clock } from '../../shared/time/clock.js';
import type { AuthRepository, UserRecord } from './auth.repository.js';
import type { PasswordHasher } from './password-hasher.js';
import { computeSessionExpiry, isSessionExpired, shouldRenewSession } from './session-policy.js';
import { generateSessionToken, hashSecret } from './session-token.js';

const CURRENT_TERMS_VERSION = '1';
const CURRENT_AI_DATA_PROCESSING_VERSION = '1';

const MINUTE_IN_MS = 60_000;

const ATTEMPT_LIMITS = {
  loginByEmail: { maxAttempts: 10, windowInMs: 15 * MINUTE_IN_MS },
  loginByIp: { maxAttempts: 30, windowInMs: 15 * MINUTE_IN_MS },
  registrationByIp: { maxAttempts: 10, windowInMs: 60 * MINUTE_IN_MS },
} as const;

export interface RegistrationInput {
  name: string;
  email: string;
  password: string;
  hasAcceptedTerms: true;
  hasConsentedToAiDataProcessing: boolean;
  clientIp: string;
}

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
  register(input: RegistrationInput): Promise<void>;
  login(input: LoginInput): Promise<{ user: UserRecord; session: IssuedSession }>;
  logout(token: string): Promise<void>;
  authenticate(token: string): Promise<Authentication>;
}

interface AuthServiceDependencies {
  repository: AuthRepository;
  passwordHasher: PasswordHasher;
  clock: Clock;
  decoyPasswordHash: string;
}

export function createAuthService({
  repository,
  passwordHasher,
  clock,
  decoyPasswordHash,
}: AuthServiceDependencies): AuthService {
  async function exceedsLimit(
    key: string,
    limit: { maxAttempts: number; windowInMs: number },
  ): Promise<boolean> {
    const now = clock.now();
    const windowStart = new Date(now.getTime() - limit.windowInMs);
    const attempts = await repository.countAttempt(key, now, windowStart);
    return attempts > limit.maxAttempts;
  }

  function tooManyAttempts(): AppError {
    return new AppError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
  }

  return {
    async register({
      name,
      email,
      password,
      hasConsentedToAiDataProcessing,
      clientIp,
    }: RegistrationInput) {
      if (
        await exceedsLimit(
          `registration:ip:${toClientNetwork(clientIp)}`,
          ATTEMPT_LIMITS.registrationByIp,
        )
      ) {
        throw tooManyAttempts();
      }

      const passwordHash = await passwordHasher.hash(password);
      await repository.createUser({
        name,
        email,
        passwordHash,
        consents: {
          terms: { version: CURRENT_TERMS_VERSION },
          aiDataProcessing: hasConsentedToAiDataProcessing
            ? { version: CURRENT_AI_DATA_PROCESSING_VERSION }
            : null,
        },
        now: clock.now(),
      });
    },

    async login({ email, password, rememberMe, clientIp }) {
      const ipKey = `login:ip:${toClientNetwork(clientIp)}`;
      const emailKey = `login:email:${hashSecret(email)}`;
      if (await exceedsLimit(ipKey, ATTEMPT_LIMITS.loginByIp)) {
        throw tooManyAttempts();
      }
      if (await exceedsLimit(emailKey, ATTEMPT_LIMITS.loginByEmail)) {
        throw tooManyAttempts();
      }

      const credentials = await repository.findCredentialsByEmail(email);
      const isPasswordValid = credentials
        ? await passwordHasher.verify(password, credentials.passwordHash)
        : await passwordHasher.verify(password, decoyPasswordHash);
      if (!credentials || !isPasswordValid) {
        throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
      }

      await repository.clearAttempts(emailKey);
      await repository.refundAttempt(ipKey);

      const token = generateSessionToken();
      const expiresAt = computeSessionExpiry(clock.now(), rememberMe);
      await repository.createSession({
        userId: credentials.id,
        tokenHash: hashSecret(token),
        isPersistent: rememberMe,
        expiresAt,
      });

      return {
        user: { id: credentials.id, name: credentials.name, email: credentials.email },
        session: { token, expiresAt },
      };
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

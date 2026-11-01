import { ConsentType } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
}

export interface UserCredentials extends UserRecord {
  passwordHash: string;
}

export interface SessionRecord {
  id: string;
  isPersistent: boolean;
  expiresAt: Date;
  user: UserRecord;
}

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
  consents: {
    terms: { version: string };
    aiDataProcessing: { version: string } | null;
  };
  now: Date;
}

export interface NewSession {
  userId: string;
  tokenHash: string;
  isPersistent: boolean;
  expiresAt: Date;
}

export interface AuthRepository {
  createUser(user: NewUser): Promise<'created' | 'email_taken'>;
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  createSession(session: NewSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  renewSession(sessionId: string, expiresAt: Date): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
  countAttempt(key: string, now: Date, windowStart: Date): Promise<number>;
  clearAttempts(key: string): Promise<void>;
  refundAttempt(key: string): Promise<void>;
}

const USER_FIELDS = { id: true, name: true, email: true } as const;

export function createAuthRepository(database: DatabaseClient): AuthRepository {
  return {
    async createUser({ name, email, passwordHash, consents, now }) {
      const { terms, aiDataProcessing } = consents;
      try {
        await database.user.create({
          data: {
            name,
            email,
            passwordHash,
            consents: {
              create: [
                { type: ConsentType.TERMS_OF_USE, version: terms.version, grantedAt: now },
                { type: ConsentType.PRIVACY_POLICY, version: terms.version, grantedAt: now },
                ...(aiDataProcessing
                  ? [
                      {
                        type: ConsentType.AI_DATA_PROCESSING,
                        version: aiDataProcessing.version,
                        grantedAt: now,
                      },
                    ]
                  : []),
              ],
            },
          },
        });
        return 'created';
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === UNIQUE_CONSTRAINT_VIOLATION
        ) {
          return 'email_taken';
        }
        throw error;
      }
    },

    findCredentialsByEmail(email) {
      return database.user.findUnique({
        where: { email },
        select: { ...USER_FIELDS, passwordHash: true },
      });
    },

    async createSession(session) {
      await database.session.create({ data: session });
    },

    findSessionByTokenHash(tokenHash) {
      return database.session.findUnique({
        where: { tokenHash },
        select: { id: true, isPersistent: true, expiresAt: true, user: { select: USER_FIELDS } },
      });
    },

    async renewSession(sessionId, expiresAt) {
      await database.session.updateMany({ where: { id: sessionId }, data: { expiresAt } });
    },

    async deleteSession(sessionId) {
      await database.session.deleteMany({ where: { id: sessionId } });
    },

    async deleteSessionByTokenHash(tokenHash) {
      await database.session.deleteMany({ where: { tokenHash } });
    },

    async countAttempt(key, now, windowStart) {
      const [counter] = await database.$queryRaw<{ attempt_count: number }[]>`
        INSERT INTO attempt_counters (key, attempt_count, window_started_at)
        VALUES (${key}, 1, ${now}::timestamptz)
        ON CONFLICT (key) DO UPDATE SET
          attempt_count = CASE
            WHEN attempt_counters.window_started_at <= ${windowStart}::timestamptz THEN 1
            ELSE attempt_counters.attempt_count + 1
          END,
          window_started_at = CASE
            WHEN attempt_counters.window_started_at <= ${windowStart}::timestamptz THEN ${now}::timestamptz
            ELSE attempt_counters.window_started_at
          END
        RETURNING attempt_count`;
      return counter?.attempt_count ?? 1;
    },

    async clearAttempts(key) {
      await database.attemptCounter.deleteMany({ where: { key } });
    },

    async refundAttempt(key) {
      await database.attemptCounter.updateMany({
        where: { key, attemptCount: { gt: 0 } },
        data: { attemptCount: { decrement: 1 } },
      });
    },
  };
}

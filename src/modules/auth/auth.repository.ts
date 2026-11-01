import type { DatabaseClient } from '../../shared/database/prisma-client.js';

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

export interface NewSession {
  userId: string;
  tokenHash: string;
  isPersistent: boolean;
  expiresAt: Date;
}

export interface AuthRepository {
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  createSessionIfPasswordUnchanged(session: NewSession, passwordHash: string): Promise<boolean>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  renewSession(sessionId: string, expiresAt: Date): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
}

const USER_FIELDS = { id: true, name: true, email: true } as const;

export function createAuthRepository(database: DatabaseClient): AuthRepository {
  return {
    findCredentialsByEmail(email) {
      return database.user.findUnique({
        where: { email },
        select: { ...USER_FIELDS, passwordHash: true },
      });
    },

    createSessionIfPasswordUnchanged(session, passwordHash) {
      return database.$transaction(async (transaction) => {
        const [user] = await transaction.$queryRaw<{ password_hash: string }[]>`
          SELECT password_hash FROM users WHERE id = ${session.userId}::uuid FOR SHARE`;
        if (user?.password_hash !== passwordHash) {
          return false;
        }
        await transaction.session.create({ data: session });
        return true;
      });
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
  };
}

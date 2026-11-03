import { IdentityProvider } from '../../generated/prisma/client.js';
import { isUniqueConstraintViolation } from '../../shared/database/prisma-client.js';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';
import type { UserRecord } from './auth.repository.js';
import { buildConsentRows } from './consents.js';
import type { ConsentVersions } from './consents.js';

export interface NewGoogleSignupToken {
  tokenHash: string;
  subject: string;
  email: string;
  name: string;
  expiresAt: Date;
}

export interface GoogleSignupCompletion extends ConsentVersions {
  tokenHash: string;
  name: string;
  now: Date;
}

export interface GoogleAuthRepository {
  findUserByIdentity(subject: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  linkIdentity(userId: string, subject: string): Promise<'linked' | 'conflict'>;
  createSignupToken(token: NewGoogleSignupToken): Promise<void>;
  deleteExpiredSignupTokens(now: Date): Promise<void>;
  findValidSignupToken(
    tokenHash: string,
    now: Date,
  ): Promise<{ email: string; name: string } | null>;
  completeSignup(completion: GoogleSignupCompletion): Promise<UserRecord | null>;
}

const USER_FIELDS = { id: true, name: true, email: true } as const;

export function createGoogleAuthRepository(database: DatabaseClient): GoogleAuthRepository {
  return {
    async findUserByIdentity(subject) {
      const identity = await database.userIdentity.findUnique({
        where: { provider_subject: { provider: IdentityProvider.GOOGLE, subject } },
        select: { user: { select: USER_FIELDS } },
      });
      return identity?.user ?? null;
    },

    findUserByEmail(email) {
      return database.user.findUnique({ where: { email }, select: USER_FIELDS });
    },

    async linkIdentity(userId, subject) {
      try {
        await database.userIdentity.create({
          data: { userId, subject, provider: IdentityProvider.GOOGLE },
        });
        return 'linked';
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          return 'conflict';
        }
        throw error;
      }
    },

    async createSignupToken(token) {
      await database.googleSignupToken.create({ data: token });
    },

    async deleteExpiredSignupTokens(now) {
      await database.googleSignupToken.deleteMany({ where: { expiresAt: { lte: now } } });
    },

    findValidSignupToken(tokenHash, now) {
      return database.googleSignupToken.findFirst({
        where: { tokenHash, expiresAt: { gt: now } },
        select: { email: true, name: true },
      });
    },

    async completeSignup({ tokenHash, name, now, ...consentVersions }) {
      try {
        return await database.$transaction(async (transaction) => {
          const token = await transaction.googleSignupToken.findUnique({ where: { tokenHash } });
          if (!token || token.expiresAt <= now) {
            return null;
          }

          const { email, subject } = token;
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${email}, 0))`;

          const { count } = await transaction.googleSignupToken.deleteMany({
            where: { id: token.id },
          });
          if (count !== 1) {
            return null;
          }

          const user = await transaction.user.create({
            data: {
              email,
              name,
              consents: { create: buildConsentRows(consentVersions, now) },
              identities: { create: { provider: IdentityProvider.GOOGLE, subject } },
            },
            select: USER_FIELDS,
          });
          await transaction.googleSignupToken.deleteMany({ where: { email } });
          await transaction.registrationToken.deleteMany({ where: { email } });
          return user;
        });
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

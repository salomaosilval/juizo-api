import { ConsentType } from '../../generated/prisma/client.js';
import { isUniqueConstraintViolation } from '../../shared/database/prisma-client.js';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';
import type { UserRecord } from './auth.repository.js';

export interface NewRegistrationToken {
  tokenHash: string;
  email: string;
  expiresAt: Date;
}

export interface CompletedRegistration {
  tokenHash: string;
  name: string;
  passwordHash: string;
  termsVersion: string;
  aiDataProcessingVersion: string | null;
  now: Date;
}

export interface RegistrationRepository {
  userExists(email: string): Promise<boolean>;
  createToken(token: NewRegistrationToken): Promise<void>;
  deleteExpiredTokens(now: Date): Promise<void>;
  findEmailByValidToken(tokenHash: string, now: Date): Promise<string | null>;
  completeRegistration(registration: CompletedRegistration): Promise<UserRecord | null>;
}

export function createRegistrationRepository(database: DatabaseClient): RegistrationRepository {
  return {
    async userExists(email) {
      const user = await database.user.findUnique({ where: { email }, select: { id: true } });
      return user !== null;
    },

    async createToken(token) {
      await database.registrationToken.create({ data: token });
    },

    async deleteExpiredTokens(now) {
      await database.registrationToken.deleteMany({ where: { expiresAt: { lte: now } } });
    },

    async findEmailByValidToken(tokenHash, now) {
      const token = await database.registrationToken.findFirst({
        where: { tokenHash, expiresAt: { gt: now } },
        select: { email: true },
      });
      return token?.email ?? null;
    },

    async completeRegistration({
      tokenHash,
      name,
      passwordHash,
      termsVersion,
      aiDataProcessingVersion,
      now,
    }) {
      try {
        return await database.$transaction(async (transaction) => {
          const token = await transaction.registrationToken.findUnique({ where: { tokenHash } });
          if (!token || token.expiresAt <= now) {
            return null;
          }

          const { email } = token;
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${email}, 0))`;

          const { count } = await transaction.registrationToken.deleteMany({
            where: { id: token.id },
          });
          if (count !== 1) {
            return null;
          }

          const user = await transaction.user.create({
            data: {
              email,
              name,
              passwordHash,
              consents: {
                create: [
                  { type: ConsentType.TERMS_OF_USE, version: termsVersion, grantedAt: now },
                  { type: ConsentType.PRIVACY_POLICY, version: termsVersion, grantedAt: now },
                  ...(aiDataProcessingVersion
                    ? [
                        {
                          type: ConsentType.AI_DATA_PROCESSING,
                          version: aiDataProcessingVersion,
                          grantedAt: now,
                        },
                      ]
                    : []),
                ],
              },
            },
            select: { id: true, name: true, email: true },
          });
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

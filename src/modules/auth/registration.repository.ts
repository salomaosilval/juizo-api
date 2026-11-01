import { ConsentType } from '../../generated/prisma/client.js';
import { isUniqueConstraintViolation } from '../../shared/database/prisma-client.js';
import type { DatabaseClient } from '../../shared/database/prisma-client.js';

export interface NewPendingRegistration {
  tokenHash: string;
  email: string;
  name: string;
  passwordHash: string;
  termsVersion: string;
  aiDataProcessingVersion: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface RegistrationRepository {
  userExists(email: string): Promise<boolean>;
  createPendingRegistration(registration: NewPendingRegistration): Promise<void>;
  rotateLatestPendingToken(
    email: string,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean>;
  completeRegistration(tokenHash: string, now: Date): Promise<'completed' | 'invalid_token'>;
  deleteExpiredPendingRegistrations(now: Date): Promise<void>;
}

export function createRegistrationRepository(database: DatabaseClient): RegistrationRepository {
  return {
    async userExists(email) {
      const user = await database.user.findUnique({ where: { email }, select: { id: true } });
      return user !== null;
    },

    async createPendingRegistration(registration) {
      await database.pendingRegistration.create({ data: registration });
    },

    async rotateLatestPendingToken(email, tokenHash, expiresAt, now) {
      const latest = await database.pendingRegistration.findFirst({
        where: { email, expiresAt: { gt: now } },
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      if (!latest) {
        return false;
      }
      await database.pendingRegistration.update({
        where: { id: latest.id },
        data: { tokenHash, expiresAt },
      });
      return true;
    },

    async completeRegistration(tokenHash, now) {
      try {
        return await database.$transaction(async (transaction) => {
          const pending = await transaction.pendingRegistration.findUnique({
            where: { tokenHash },
          });
          if (!pending || pending.expiresAt <= now) {
            return 'invalid_token';
          }

          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${pending.email}, 0))`;

          const { count } = await transaction.pendingRegistration.deleteMany({
            where: { id: pending.id },
          });
          if (count !== 1) {
            return 'invalid_token';
          }

          const { email, name, passwordHash, termsVersion, aiDataProcessingVersion } = pending;
          const grantedAt = pending.createdAt;
          await transaction.user.create({
            data: {
              email,
              name,
              passwordHash,
              consents: {
                create: [
                  { type: ConsentType.TERMS_OF_USE, version: termsVersion, grantedAt },
                  { type: ConsentType.PRIVACY_POLICY, version: termsVersion, grantedAt },
                  ...(aiDataProcessingVersion
                    ? [
                        {
                          type: ConsentType.AI_DATA_PROCESSING,
                          version: aiDataProcessingVersion,
                          grantedAt,
                        },
                      ]
                    : []),
                ],
              },
            },
          });
          await transaction.pendingRegistration.deleteMany({ where: { email } });
          return 'completed';
        });
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          return 'invalid_token';
        }
        throw error;
      }
    },

    async deleteExpiredPendingRegistrations(now) {
      await database.pendingRegistration.deleteMany({ where: { expiresAt: { lte: now } } });
    },
  };
}

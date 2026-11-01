import type { DatabaseClient } from '../../shared/database/prisma-client.js';

export interface PasswordRecoveryRepository {
  findUserIdByEmail(email: string): Promise<string | null>;
  replaceResetToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  isResetTokenValid(tokenHash: string, now: Date): Promise<boolean>;
  resetPassword(tokenHash: string, passwordHash: string, now: Date): Promise<string | null>;
}

export function createPasswordRecoveryRepository(
  database: DatabaseClient,
): PasswordRecoveryRepository {
  return {
    async findUserIdByEmail(email) {
      const user = await database.user.findUnique({ where: { email }, select: { id: true } });
      return user?.id ?? null;
    },

    async replaceResetToken(userId, tokenHash, expiresAt) {
      await database.passwordResetToken.upsert({
        where: { userId },
        create: { userId, tokenHash, expiresAt },
        update: { tokenHash, expiresAt },
      });
    },

    async isResetTokenValid(tokenHash, now) {
      const count = await database.passwordResetToken.count({
        where: { tokenHash, expiresAt: { gt: now } },
      });
      return count === 1;
    },

    resetPassword(tokenHash, passwordHash, now) {
      return database.$transaction(async (transaction) => {
        const resetToken = await transaction.passwordResetToken.findUnique({
          where: { tokenHash },
          select: { id: true, userId: true, expiresAt: true },
        });
        if (!resetToken || resetToken.expiresAt <= now) {
          return null;
        }

        const { count } = await transaction.passwordResetToken.deleteMany({
          where: { id: resetToken.id },
        });
        if (count !== 1) {
          return null;
        }

        const { userId } = resetToken;
        const { email } = await transaction.user.update({
          where: { id: userId },
          data: { passwordHash },
          select: { email: true },
        });
        await transaction.session.deleteMany({ where: { userId } });
        await transaction.passwordResetToken.deleteMany({ where: { userId } });
        return email;
      });
    },
  };
}

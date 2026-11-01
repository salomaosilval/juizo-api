import type { DatabaseClient } from '../../shared/database/prisma-client.js';

export interface AttemptRepository {
  countAttempt(key: string, now: Date, windowStart: Date): Promise<number>;
  clearAttempts(key: string): Promise<void>;
  refundAttempt(key: string): Promise<void>;
}

export function createAttemptRepository(database: DatabaseClient): AttemptRepository {
  return {
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

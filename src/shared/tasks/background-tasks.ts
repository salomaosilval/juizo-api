export interface BackgroundTasks {
  run(name: string, task: () => Promise<void>): void;
  drain(): Promise<void>;
}

interface ErrorLogger {
  error(context: object, message: string): void;
}

export function createBackgroundTasks(logger: ErrorLogger): BackgroundTasks {
  const runningTasks = new Set<Promise<void>>();

  return {
    run(name, task) {
      const running = task()
        .catch((error: unknown) => {
          logger.error({ err: error, task: name }, 'Background task failed');
        })
        .finally(() => {
          runningTasks.delete(running);
        });
      runningTasks.add(running);
    },

    async drain() {
      while (runningTasks.size > 0) {
        await Promise.all(runningTasks);
      }
    },
  };
}

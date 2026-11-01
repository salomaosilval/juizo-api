import { describe, expect, it, vi } from 'vitest';
import { createBackgroundTasks } from './background-tasks.js';

describe('BackgroundTasks', () => {
  it('waits for running tasks when draining', async () => {
    const tasks = createBackgroundTasks({ error: vi.fn() });
    let isFinished = false;

    tasks.run('slow task', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      isFinished = true;
    });
    await tasks.drain();

    expect(isFinished).toBe(true);
  });

  it('also waits for tasks started by another task', async () => {
    const tasks = createBackgroundTasks({ error: vi.fn() });
    let isNestedFinished = false;

    tasks.run('outer task', () => {
      tasks.run('nested task', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        isNestedFinished = true;
      });
      return Promise.resolve();
    });
    await tasks.drain();

    expect(isNestedFinished).toBe(true);
  });

  it('logs a failure instead of rejecting', async () => {
    const error = vi.fn();
    const tasks = createBackgroundTasks({ error });
    const failure = new Error('provider is down');

    tasks.run('send email', () => Promise.reject(failure));
    await tasks.drain();

    expect(error).toHaveBeenCalledExactlyOnceWith(
      { err: failure, task: 'send email' },
      'Background task failed',
    );
  });
});

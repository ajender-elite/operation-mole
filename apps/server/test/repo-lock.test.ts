import { describe, expect, it } from 'vitest';
import { ReadWriteLock } from '../src/git/repo-lock.ts';

/*
 * Many readers or one writer at a time, admitted in arrival order: a writer that is waiting is not
 * overtaken by later readers, so writes cannot be starved.
 */

/** A promise and the function that settles it, so a test decides when a task finishes. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('ReadWriteLock', () => {
  it('runs readers together', async () => {
    const lock = new ReadWriteLock();
    const first = gate();
    const second = gate();
    let running = 0;
    const read = (g: typeof first) =>
      lock.read(async () => {
        running += 1;
        await g.wait;
      });
    const a = read(first);
    const b = read(second);
    await settle();
    expect(running).toBe(2);
    first.open();
    second.open();
    await Promise.all([a, b]);
  });

  it('makes a writer wait for the readers in progress', async () => {
    const lock = new ReadWriteLock();
    const reading = gate();
    let didWrite = false;
    const read = lock.read(() => reading.wait);
    const write = lock.write(() => {
      didWrite = true;
      return Promise.resolve();
    });
    await settle();
    expect(didWrite).toBe(false);
    reading.open();
    await Promise.all([read, write]);
    expect(didWrite).toBe(true);
  });

  it('makes readers wait for a writer in progress', async () => {
    const lock = new ReadWriteLock();
    const writing = gate();
    let didRead = false;
    const write = lock.write(() => writing.wait);
    const reader = lock.read(() => {
      didRead = true;
      return Promise.resolve();
    });
    await settle();
    expect(didRead).toBe(false);
    writing.open();
    await Promise.all([write, reader]);
    expect(didRead).toBe(true);
  });

  it('does not let later readers overtake a waiting writer', async () => {
    const lock = new ReadWriteLock();
    const first = gate();
    const order: string[] = [];
    const firstRead = lock.read(async () => {
      await first.wait;
      order.push('first read');
    });
    const write = lock.write(() => {
      order.push('write');
      return Promise.resolve();
    });
    const lateRead = lock.read(() => {
      order.push('late read');
      return Promise.resolve();
    });
    await settle();
    first.open();
    await Promise.all([firstRead, write, lateRead]);
    expect(order).toEqual(['first read', 'write', 'late read']);
  });

  it('releases the lock when a task throws', async () => {
    const lock = new ReadWriteLock();
    await expect(lock.write(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(lock.write(() => Promise.resolve('next'))).resolves.toBe('next');
    await expect(lock.read(() => Promise.resolve('reader'))).resolves.toBe('reader');
  });

  it('returns the task’s result', async () => {
    const lock = new ReadWriteLock();
    await expect(lock.read(() => Promise.resolve(42))).resolves.toBe(42);
  });
});

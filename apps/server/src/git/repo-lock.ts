type Mode = 'read' | 'write';

type Waiter = { mode: Mode; admit: () => void };

/**
 * Many readers or one writer at a time. Requests are admitted in arrival order: a reader arriving
 * behind a waiting writer waits for it, so a writer (fetch, prune) cannot be starved by readers
 * (analysis).
 */
export class ReadWriteLock {
  #readers = 0;
  #hasWriter = false;
  readonly #queue: Waiter[] = [];

  read<T>(task: () => Promise<T>): Promise<T> {
    return this.#run('read', task);
  }

  write<T>(task: () => Promise<T>): Promise<T> {
    return this.#run('write', task);
  }

  #run<T>(mode: Mode, task: () => Promise<T>): Promise<T> {
    return new Promise<void>((admit) => {
      this.#queue.push({ mode, admit });
      this.#admitWaiters();
    }).then(async () => {
      try {
        return await task();
      } finally {
        this.#release(mode);
      }
    });
  }

  /** Admits waiters from the front while they are compatible with what is running. */
  #admitWaiters(): void {
    for (;;) {
      const next = this.#queue[0];
      if (next === undefined) return;
      if (next.mode === 'write') {
        if (this.#hasWriter || this.#readers > 0) return;
        this.#hasWriter = true;
      } else {
        if (this.#hasWriter) return;
        this.#readers += 1;
      }
      this.#queue.shift();
      next.admit();
    }
  }

  #release(mode: Mode): void {
    if (mode === 'write') this.#hasWriter = false;
    else this.#readers -= 1;
    this.#admitWaiters();
  }
}

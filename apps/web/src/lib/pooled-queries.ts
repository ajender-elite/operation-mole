import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/** One unit of background analysis: a cached query to run. */
export type PooledTask<TData> = {
  id: string;
  /** The query's key, used to cancel it and to tell task lists apart. */
  queryKey: QueryKey;
  /** Runs (or reuses) the query, e.g. `client.query(options)`. */
  run: (client: QueryClient) => Promise<TData>;
};

/** Progress and results of {@link usePooledQueries}, in completion order. */
export type PooledResults<TData> = {
  results: Array<{ id: string; data: TData }>;
  errors: Array<{ id: string; message: string }>;
  done: number;
  total: number;
  isRunning: boolean;
};

/**
 * Runs `tasks` in the background, at most `concurrency` at a time, reporting results as they
 * arrive. Cached queries resolve at once, so revisiting a scope is instant. When the task list
 * changes or the component unmounts, it stops scheduling and cancels what is in flight;
 * completed results stay in the query cache.
 */
export function usePooledQueries<TData>(
  tasks: Array<PooledTask<TData>>,
  isEnabled: boolean,
  concurrency: number,
): PooledResults<TData> {
  const client = useQueryClient();
  const key = JSON.stringify(tasks.map((t) => t.queryKey));
  const [state, setState] = useState<{
    key: string;
    results: PooledResults<TData>['results'];
    errors: PooledResults<TData>['errors'];
  }>({ key: '', results: [], errors: [] });

  useEffect(() => {
    if (!isEnabled) return;
    const run = { isCancelled: false };
    // A function, so TypeScript doesn't narrow the flag across awaits.
    const isStopped = () => run.isCancelled;
    const queue = [...tasks];
    const results: PooledResults<TData>['results'] = [];
    const errors: PooledResults<TData>['errors'] = [];
    const inFlight = new Set<PooledTask<TData>>();
    const publish = () => {
      if (!isStopped()) setState({ key, results: [...results], errors: [...errors] });
    };
    const worker = async () => {
      for (let task = queue.shift(); task !== undefined && !isStopped(); task = queue.shift()) {
        const current = task;
        inFlight.add(current);
        try {
          results.push({ id: current.id, data: await current.run(client) });
        } catch (error) {
          if (isStopped()) return;
          errors.push({
            id: current.id,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          inFlight.delete(current);
        }
        publish();
      }
    };
    publish();
    void Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return () => {
      run.isCancelled = true;
      for (const task of inFlight) void client.cancelQueries({ queryKey: task.queryKey });
    };
    // `key` stands for `tasks` (new arrays with the same queries must not restart the work).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isEnabled, client, concurrency]);

  const isCurrent = state.key === key;
  const done = isCurrent ? state.results.length + state.errors.length : 0;
  return {
    results: isCurrent ? state.results : [],
    errors: isCurrent ? state.errors : [],
    done,
    total: tasks.length,
    isRunning: isEnabled && done < tasks.length,
  };
}

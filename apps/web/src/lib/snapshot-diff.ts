import type { GitSource, SnapshotFileDiff } from '@om/shared';
import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { snapshotFileDiff } from './api.ts';
import type { AttributionInput, DiffTarget } from './attribution.ts';
import { usePooledQueries, type PooledTask } from './pooled-queries.ts';

/** The two git snapshots of a comparison, in a session. */
export type SnapshotPair = {
  user: string;
  sessionId: string;
  left: GitSource;
  right: GitSource;
};

const KEY = 'snapshot-file-diff';

/**
 * The query for one file's snapshot diff. Directory attribution and an explained file view share
 * it, so whichever runs first fills the cache for the other. With `isAttributed: false` the
 * server skips git blame: the plain difference, shown before anyone asks what accounts for it.
 */
export function fileDiffQuery(
  pair: SnapshotPair,
  target: DiffTarget,
  isFullFile = false,
  isAttributed = true,
): ReturnType<typeof buildFileDiffQuery> {
  return buildFileDiffQuery(pair, target, isFullFile, isAttributed);
}

const buildFileDiffQuery = (
  pair: SnapshotPair,
  target: DiffTarget,
  isFullFile: boolean,
  isAttributed: boolean,
) =>
  queryOptions({
    queryKey: [
      KEY,
      pair.user,
      pair.sessionId,
      pair.left,
      pair.right,
      target.leftPath ?? null,
      target.rightPath ?? null,
      isFullFile,
      isAttributed,
    ] as const,
    queryFn: ({ signal }) =>
      snapshotFileDiff(
        {
          user: pair.user,
          sessionId: pair.sessionId,
          left: pair.left,
          right: pair.right,
          ...(target.leftPath === undefined ? {} : { leftPath: target.leftPath }),
          ...(target.rightPath === undefined ? {} : { rightPath: target.rightPath }),
          fullFile: isFullFile,
          attribute: isAttributed,
        },
        signal,
      ),
    staleTime: Infinity,
  });

function cachedDiffs(client: QueryClient, pair: SnapshotPair): AttributionInput {
  const prefix = [KEY, pair.user, pair.sessionId, pair.left, pair.right];
  const byKey = new Map<string, SnapshotFileDiff>();
  for (const query of client.getQueryCache().findAll({ queryKey: prefix })) {
    if (query.state.status !== 'success') continue;
    // Only attributed diffs say which commits account for what.
    if (query.queryKey[8] !== true) continue;
    // Every query under this key prefix is a fileDiffQuery, so its data is a SnapshotFileDiff.
    const diff = client.getQueryData<SnapshotFileDiff>(query.queryKey);
    if (diff === undefined) continue;
    const key = diff.leftPath ?? diff.rightPath ?? '';
    // Prefer the 3-line-context version: same attribution, smaller.
    if (!byKey.has(key) || query.queryKey[7] === false) byKey.set(key, diff);
  }
  return [...byKey].map(([key, diff]) => ({ key, diff }));
}

/**
 * Every file diff of this comparison analyzed so far (by directory attribution or by opening
 * files): what "where else does this commit account for differences?" can be answered from
 * without new work. Updates as more files are analyzed.
 */
export function useAnalyzedDiffs(pair: SnapshotPair | undefined): AttributionInput {
  const client = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) =>
      // The cache also changes while components render (useQuery registers its query then),
      // so tell React afterwards rather than in the middle of someone else's render.
      client.getQueryCache().subscribe(() => {
        queueMicrotask(onChange);
      }),
    [client],
  );
  const version = useSyncExternalStore(subscribe, () =>
    client
      .getQueryCache()
      .getAll()
      .reduce((n, q) => n + (q.state.status === 'success' ? 1 : 0), 0),
  );
  // `version` changes whenever a query succeeds: that is when the cached diffs change.
  return useMemo(
    () => (version >= 0 && pair ? cachedDiffs(client, pair) : []),
    [client, pair, version],
  );
}

/** Progress and results of {@link useDirectoryAttribution}. */
export type DirectoryAttribution = {
  results: AttributionInput;
  /** Files whose diff failed, with the error message. */
  errors: Array<{ key: string; message: string }>;
  done: number;
  total: number;
  isRunning: boolean;
};

/** How many file diffs directory attribution runs at once. */
const CONCURRENCY = 4;

/**
 * Diffs (with attribution) every file in `targets`, at most {@link CONCURRENCY} at a time,
 * reusing cached results; see {@link usePooledQueries}.
 */
export function useDirectoryAttribution(
  pair: SnapshotPair | undefined,
  targets: DiffTarget[],
  isEnabled: boolean,
): DirectoryAttribution {
  const tasks: Array<PooledTask<SnapshotFileDiff>> = pair
    ? targets.map((target) => {
        const options = fileDiffQuery(pair, target);
        return {
          id: target.key,
          queryKey: options.queryKey,
          run: (client) => client.query(options),
        };
      })
    : [];
  const pooled = usePooledQueries(tasks, pair !== undefined && isEnabled, CONCURRENCY);
  return {
    results: pooled.results.map(({ id, data }) => ({ key: id, diff: data })),
    errors: pooled.errors.map(({ id, message }) => ({ key: id, message })),
    done: pooled.done,
    total: targets.length,
    isRunning: pooled.isRunning,
  };
}

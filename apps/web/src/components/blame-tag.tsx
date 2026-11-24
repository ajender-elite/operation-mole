import type { GitSource } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useState } from 'react';
import { gitShow } from '../lib/api.ts';
import { shortSha } from '../lib/attribution.ts';
import type { CodeRow } from '../lib/code-lines.ts';
import { formatDate } from '../lib/dates.ts';
import { codeUrl, commitsUrl, commitUrl } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/**
 * The last change to a line, shown where a run of lines from one commit starts. A tag opens a small panel with
 * the commit and what to do with it: open it, its history of this file, the file as it was then, and the file
 * just before the change. Each opens in a tab of its own (or the tab that is already open).
 */
export function BlameTag({
  row,
  user,
  sessionId,
  source,
  path,
}: {
  row: CodeRow;
  user: string;
  sessionId: string;
  source: GitSource;
  path: string;
}): JSX.Element | null {
  const workspace = useWorkspace();
  const [isOpen, setOpen] = useState(false);
  const commit = row.commit;
  // The parents come from the commit's own metadata, read only when the panel opens (the commit page shares it).
  const details = useQuery({
    queryKey: ['git-show', user, sessionId, source.repoId, commit?.sha ?? ''] as const,
    queryFn: ({ signal }) =>
      gitShow(
        {
          user,
          sessionId,
          source: { type: 'git', repoId: source.repoId, branch: commit?.sha ?? '' },
        },
        signal,
      ),
    enabled: isOpen && commit !== undefined,
  });
  if (!row.isRunStart || commit === undefined) return null;
  const atCommit: GitSource = { ...source, branch: commit.sha };
  const parent = details.data?.details.parents[0];
  // Before the change, the file has the path it had then (a rename may have moved it).
  const pathBefore = row.origPath ?? path;
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={`Last change ${shortSha(commit.sha)} by ${commit.authorName}`}
        className="flex items-center gap-1 font-sans hover:underline"
        onClick={() => {
          setOpen((open) => !open);
        }}
      >
        <span className="font-mono text-ink">{shortSha(commit.sha)}</span>
        <span className="max-w-32 truncate">{commit.authorName}</span>
      </button>
      {isOpen && (
        <span
          role="dialog"
          aria-label={`Commit ${shortSha(commit.sha)}`}
          className="absolute left-0 top-full z-20 mt-1 flex w-72 flex-col gap-2 rounded-md border border-line bg-surface p-3 text-xs shadow-lg"
        >
          <span className="text-sm text-ink">{commit.subject}</span>
          <span className="text-muted">
            {commit.authorName} · {formatDate(commit.authorDate)}
          </span>
          <span className="flex flex-wrap gap-1.5 pt-1">
            <button
              type="button"
              className="touch-target rounded-md border border-line px-2 py-1 hover:bg-hover"
              onClick={() => {
                workspace.open(commitUrl(user, sessionId, source.repoId, commit.sha));
              }}
            >
              Open commit
            </button>
            <button
              type="button"
              className="touch-target rounded-md border border-line px-2 py-1 hover:bg-hover"
              onClick={() => {
                workspace.open(commitsUrl(user, sessionId, atCommit, { path }));
              }}
            >
              History of this file
            </button>
            <button
              type="button"
              className="touch-target rounded-md border border-line px-2 py-1 hover:bg-hover"
              onClick={() => {
                workspace.open(codeUrl(user, sessionId, atCommit, { path }));
              }}
            >
              View file at this commit
            </button>
          </span>
          {details.data !== undefined && parent === undefined && (
            <span className="text-muted">
              No earlier version: this is the first commit of the file.
            </span>
          )}
          {parent !== undefined && (
            <span className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className="touch-target rounded-md border border-line px-2 py-1 hover:bg-hover"
                onClick={() => {
                  workspace.open(
                    codeUrl(user, sessionId, { ...source, branch: parent }, { path: pathBefore }),
                  );
                }}
              >
                Blame before this change
              </button>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

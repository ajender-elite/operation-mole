import type { GitSource, GitTreeNode } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';
import { useState, type JSX } from 'react';
import { Link } from 'react-router';
import { gitTree } from '../lib/api.ts';
import { isWithin } from '../lib/paths.ts';
import { codeUrl } from '../lib/urls.ts';

/**
 * The files of a ref as a tree you can open folder by folder. Each folder's listing loads when it opens, and
 * shares its cache with the Code tab's folder view. A folder that holds the current path starts open.
 */
export function FileTree({
  user,
  sessionId,
  source,
  currentPath,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  currentPath: string;
}): JSX.Element {
  return (
    <nav aria-label="Files in this ref" className="min-h-0 flex-1 overflow-auto py-2 text-sm">
      <TreeFolder
        user={user}
        sessionId={sessionId}
        source={source}
        folder=""
        depth={0}
        currentPath={currentPath}
      />
    </nav>
  );
}

function TreeFolder({
  user,
  sessionId,
  source,
  folder,
  depth,
  currentPath,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  folder: string;
  depth: number;
  currentPath: string;
}): JSX.Element {
  const listing = useQuery({
    queryKey: [
      'git-tree',
      user,
      sessionId,
      source.repoId,
      source.remote ?? '',
      source.branch,
      folder,
    ] as const,
    queryFn: ({ signal }) =>
      gitTree({ user, sessionId, source, ...(folder === '' ? {} : { path: folder }) }, signal),
  });
  const indent = { paddingLeft: `${depth * 0.75 + 0.5}rem` };
  if (listing.isError) {
    return (
      <p role="alert" className="px-2 py-1 text-xs text-error" style={indent}>
        {listing.error.message}
      </p>
    );
  }
  if (!listing.data) {
    return (
      <p className="px-2 py-1 text-xs text-muted" style={indent}>
        Loading…
      </p>
    );
  }
  return (
    <ul role="group" className="space-y-px">
      {listing.data.entries.map((entry) =>
        entry.kind === 'directory' ? (
          <TreeDirectory
            key={entry.path}
            user={user}
            sessionId={sessionId}
            source={source}
            entry={entry}
            depth={depth}
            currentPath={currentPath}
          />
        ) : (
          <TreeFile
            key={entry.path}
            user={user}
            sessionId={sessionId}
            source={source}
            entry={entry}
            depth={depth}
            currentPath={currentPath}
          />
        ),
      )}
    </ul>
  );
}

function TreeDirectory({
  user,
  sessionId,
  source,
  entry,
  depth,
  currentPath,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  entry: GitTreeNode;
  depth: number;
  currentPath: string;
}): JSX.Element {
  const [isOpen, setOpen] = useState(isWithin(entry.path, currentPath) && currentPath !== '');
  const indent = { paddingLeft: `${depth * 0.75 + 0.5}rem` };
  return (
    <li>
      <div className="flex items-center gap-0.5 pr-2" style={indent}>
        <button
          type="button"
          aria-label={`${isOpen ? 'Close' : 'Open'} ${entry.name}`}
          aria-expanded={isOpen}
          className="touch-target flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover"
          onClick={() => {
            setOpen((open) => !open);
          }}
        >
          {isOpen ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
        </button>
        <Link
          to={codeUrl(user, sessionId, source, { path: entry.path })}
          onClick={() => {
            setOpen(true);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover"
        >
          <Folder className="size-3.5 shrink-0 text-accent" aria-hidden />
          <span className="truncate">{entry.name}</span>
        </Link>
      </div>
      {isOpen && (
        <TreeFolder
          user={user}
          sessionId={sessionId}
          source={source}
          folder={entry.path}
          depth={depth + 1}
          currentPath={currentPath}
        />
      )}
    </li>
  );
}

function TreeFile({
  user,
  sessionId,
  source,
  entry,
  depth,
  currentPath,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  entry: GitTreeNode;
  depth: number;
  currentPath: string;
}): JSX.Element {
  const isCurrent = entry.path === currentPath;
  return (
    <li>
      <Link
        to={codeUrl(user, sessionId, source, { path: entry.path })}
        aria-current={isCurrent ? 'page' : undefined}
        className={clsx(
          'flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover',
          isCurrent && 'bg-accent-soft font-medium text-ink',
        )}
        style={{ paddingLeft: `${depth * 0.75 + 1.75}rem` }}
      >
        <File className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate">{entry.name}</span>
      </Link>
    </li>
  );
}

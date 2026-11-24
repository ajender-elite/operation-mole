import type { GitBlame, GitFile, GitSource, GitTreeNode } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Copy,
  File,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  GitCompare,
  History,
} from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BlameTag } from '../components/blame-tag.tsx';
import { CodeView } from '../components/code-view.tsx';
import { ExploreHeader } from '../components/explore-header.tsx';
import { RefPicker } from '../components/ref-picker.tsx';
import { FileFinder } from '../components/file-finder.tsx';
import { FileTree } from '../components/file-tree.tsx';
import { Loading, Notice } from '../components/notice.tsx';
import { gitBlame, gitFile, gitFiles, gitTree } from '../lib/api.ts';
import { copyText } from '../lib/clipboard.ts';
import { codeRows, formatLineRange, parseLineRange, type LineRange } from '../lib/code-lines.ts';
import { exploreLinks } from '../lib/explore-links.ts';
import { highlightLines, type HighlightedToken } from '../lib/highlight.ts';
import { isEditable } from '../lib/keys.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { useRepoRefs } from '../lib/repo-refs.ts';
import { refSourceFromParams } from '../lib/sources.ts';
import { toSource } from '../lib/source-draft.ts';
import { codeUrl, commitsUrl, foldersUrl, searchUrl } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/**
 * Code tab: one ref of one repo, explored. A tree of the ref sits beside the body. A folder lists its folders
 * and files (folders first), with its README under the listing. A file shows its lines, each with its last
 * change (blame), on by default and hidable (`blame=0`). Permalink copies the view pinned to the exact commit.
 */
export function CodePage(): JSX.Element {
  const [params] = useSearchParams();
  const source = refSourceFromParams(params);
  if (source === undefined) {
    return (
      <Notice>
        This code link is incomplete. Open it from the repository&apos;s branches or the Overview.
      </Notice>
    );
  }
  return (
    <CodeExplorer
      key={`${source.repoId}/${source.remote ?? ''}/${source.branch}`}
      source={source}
    />
  );
}

function CodeExplorer({ source }: { source: GitSource }): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const [params] = useSearchParams();
  const workspace = useWorkspace();
  const path = params.get('path') ?? '';
  const lines = parseLineRange(params.get('lines'));
  const isBlameOn = params.get('blame') !== '0';
  const [isFinding, setFinding] = useState(false);

  const repo = session.data?.repos.find((r) => r.id === source.repoId);
  // Every branch and tag of the repo, for the ref picker in the header.
  const refs = useRepoRefs(user, sessionId, source.repoId, repo !== undefined);
  // Every path of the ref, loaded the first time go-to-file opens (no blob is read for it).
  const everyFile = useQuery({
    queryKey: [
      'git-files',
      user,
      sessionId,
      source.repoId,
      source.remote ?? '',
      source.branch,
    ] as const,
    queryFn: ({ signal }) => gitFiles({ user, sessionId, source }, signal),
    enabled: isFinding && repo !== undefined,
  });
  // Shortcuts: t goes to a file by name, / opens Search. Neither fires while the user types in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      if (event.key === 't') {
        event.preventDefault();
        setFinding(true);
      } else if (event.key === '/') {
        event.preventDefault();
        workspace.open(searchUrl(user, sessionId, source));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [user, sessionId, source, workspace]);

  const name = path.split('/').at(-1) ?? '';
  const folderOfPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const keyOf = (kind: string, at: string) =>
    [kind, user, sessionId, source.repoId, source.remote ?? '', source.branch, at] as const;

  // The listing of the folder that holds `path` (the root listing when `path` is at the top).
  const parent = useQuery({
    queryKey: keyOf('git-tree', folderOfPath),
    queryFn: ({ signal }) =>
      gitTree(
        { user, sessionId, source, ...(folderOfPath === '' ? {} : { path: folderOfPath }) },
        signal,
      ),
    enabled: repo !== undefined,
  });
  const entry: GitTreeNode | undefined =
    path === '' ? undefined : parent.data?.entries.find((e) => e.name === name);
  const isFolder = path === '' || entry?.kind === 'directory';

  const folder = useQuery({
    queryKey: keyOf('git-tree', path),
    queryFn: ({ signal }) =>
      gitTree({ user, sessionId, source, ...(path === '' ? {} : { path }) }, signal),
    enabled: repo !== undefined && isFolder,
  });
  const file = useQuery({
    queryKey: keyOf('git-file', path),
    queryFn: ({ signal }) => gitFile({ user, sessionId, source, path }, signal),
    enabled: repo !== undefined && path !== '' && entry !== undefined && !isFolder,
  });
  const isText = file.data?.content === 'text';
  const blame = useQuery({
    queryKey: keyOf('git-blame', path),
    queryFn: ({ signal }) => gitBlame({ user, sessionId, source, path }, signal),
    enabled: isText && isBlameOn,
  });
  // Colours follow the content: keyed by the blob, so a changed file is highlighted again.
  const highlighted = useQuery({
    queryKey: [...keyOf('highlight', path), file.data?.oid ?? ''] as const,
    // null, not undefined, for a file shown as plain text: a query must resolve to a value.
    queryFn: async () => (await highlightLines(file.data?.text ?? '', path)) ?? null,
    enabled: isText,
  });

  // A permalink names the exact commit the view was read at, so it keeps meaning the same thing later.
  const commitSha = isFolder ? folder.data?.commit : file.data?.commit;
  const permalink =
    commitSha === undefined
      ? undefined
      : new URL(
          codeUrl(
            user,
            sessionId,
            { ...source, branch: commitSha },
            { path, ...(lines === undefined ? {} : { lines: formatLineRange(lines) }) },
          ),
          window.location.origin,
        ).href;
  // y copies the permalink, as the Copy button does. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      if (event.key === 'y' && permalink !== undefined) {
        event.preventDefault();
        void copyText(permalink);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [permalink]);

  if (session.isError) return <Notice tone="error">{session.error.message}</Notice>;
  if (session.isPending) return <Loading label="Loading session…" />;
  if (repo === undefined) {
    return <Notice>This repository is no longer in the session.</Notice>;
  }

  const remote = source.remote ?? repo.remotes[0]?.name ?? 'origin';
  const openHistory = (target?: string) => {
    workspace.open(commitsUrl(user, sessionId, source, { path: target }));
  };

  let body: JSX.Element;
  if (path !== '' && parent.isError) {
    body = <Notice tone="error">{parent.error.message}</Notice>;
  } else if (path !== '' && parent.isSuccess && entry === undefined) {
    body = <Notice>{`${path} is not in ${source.branch}.`}</Notice>;
  } else if (isFolder) {
    if (folder.isError) body = <Notice tone="error">{folder.error.message}</Notice>;
    else if (!folder.data) body = <Loading label="Loading folder…" />;
    else
      body = (
        <FolderListing
          user={user}
          sessionId={sessionId}
          source={source}
          path={path}
          entries={folder.data.entries}
          onHistory={() => {
            openHistory(path === '' ? undefined : path);
          }}
          onCompare={() => {
            workspace.open(foldersUrl(user, sessionId, source, source, path));
          }}
        />
      );
  } else if (file.isError) {
    body = <Notice tone="error">{file.error.message}</Notice>;
  } else if (!file.data) {
    body = <Loading label="Loading file…" />;
  } else {
    body = (
      <FileView
        user={user}
        sessionId={sessionId}
        source={source}
        path={path}
        file={file.data}
        blame={isText && isBlameOn ? blame.data : undefined}
        isBlameOn={isBlameOn}
        isBlameLoading={isText && isBlameOn && blame.isPending}
        isBlameFailed={blame.isError}
        lines={lines}
        tokens={highlighted.data ?? undefined}
        onHistory={() => {
          openHistory(path);
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExploreHeader
        where={repo.name}
        picker={
          <RefPicker
            remotes={repo.remotes.map((r) => r.name)}
            refs={refs.data?.refs}
            isLoading={refs.isPending}
            current={{ remote, name: source.branch }}
            onOpen={(choice) => {
              const next = toSource({
                type: 'git',
                repoId: source.repoId,
                remote: choice.remote,
                branch: choice.name,
              });
              workspace.open(codeUrl(user, sessionId, next, { path }));
            }}
          />
        }
        links={exploreLinks(user, sessionId, source, 'code')}
        onOpen={(url) => {
          workspace.open(url);
        }}
      />
      <Breadcrumb
        user={user}
        sessionId={sessionId}
        source={source}
        path={path}
        permalink={permalink}
        onCopyPermalink={() => {
          if (permalink !== undefined) void copyText(permalink);
        }}
      />
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Files"
          className="hidden w-64 shrink-0 flex-col overflow-hidden border-r border-line md:flex"
        >
          <FileTree user={user} sessionId={sessionId} source={source} currentPath={path} />
        </aside>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{body}</div>
      </div>
      {isFinding && (
        <FileFinder
          paths={everyFile.data?.paths}
          isLoading={everyFile.isPending}
          error={everyFile.error?.message}
          onPick={(picked) => {
            setFinding(false);
            workspace.open(codeUrl(user, sessionId, source, { path: picked }));
          }}
          onClose={() => {
            setFinding(false);
          }}
        />
      )}
    </div>
  );
}

function Breadcrumb({
  user,
  sessionId,
  source,
  path,
  permalink,
  onCopyPermalink,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  path: string;
  permalink: string | undefined;
  onCopyPermalink: () => void;
}): JSX.Element {
  const segments = path === '' ? [] : path.split('/');
  return (
    <nav
      aria-label="Path"
      className="flex flex-wrap items-center gap-1 px-4 py-2 text-sm text-muted"
    >
      <Link className="hover:text-ink" to={codeUrl(user, sessionId, source)}>
        {source.branch}
      </Link>
      {segments.map((segment, index) => {
        const to = segments.slice(0, index + 1).join('/');
        return (
          <span key={to} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <Link className="hover:text-ink" to={codeUrl(user, sessionId, source, { path: to })}>
              {segment}
            </Link>
          </span>
        );
      })}
      {permalink !== undefined && (
        <button
          type="button"
          title="Copy a link to this view, pinned to the exact commit (y)"
          className="touch-target ml-auto flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs hover:bg-hover"
          onClick={onCopyPermalink}
        >
          <Copy className="size-3.5" aria-hidden /> Copy permalink
        </button>
      )}
    </nav>
  );
}

function FolderListing({
  user,
  sessionId,
  source,
  path,
  entries,
  onHistory,
  onCompare,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  path: string;
  entries: GitTreeNode[];
  onHistory: () => void;
  /** Opens Folder Compare on this folder, with this ref on both sides (the caller's `user` and session). */
  onCompare: () => void;
}): JSX.Element {
  const readme = entries.find(
    (entry) => entry.kind === 'file' && /^readme(\.(md|markdown|txt|rst))?$/i.test(entry.name),
  );
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="touch-target flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:bg-hover"
          onClick={onCompare}
        >
          <GitCompare className="size-4" aria-hidden /> Compare this folder with another ref
        </button>
        <button
          type="button"
          className="touch-target flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:bg-hover"
          onClick={onHistory}
        >
          <History className="size-4" aria-hidden /> Commits touching this folder
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted">This folder is empty.</p>
      ) : (
        <ul
          aria-label={path === '' ? 'Files and folders' : `Contents of ${path}`}
          className="divide-y divide-line rounded-md border border-line bg-surface"
        >
          {entries.map((entry) => {
            const isDirectory = entry.kind === 'directory';
            const Icon = isDirectory ? Folder : File;
            return (
              <li key={entry.path}>
                <Link
                  to={codeUrl(user, sessionId, source, { path: entry.path })}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-hover"
                >
                  <Icon
                    className={clsx('size-4 shrink-0', isDirectory ? 'text-accent' : 'text-muted')}
                    aria-hidden
                  />
                  <span className="truncate">{entry.name}</span>
                  {entry.kind === 'submodule' && (
                    <span className="text-xs text-muted">submodule</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {readme !== undefined && (
        <ReadmeText user={user} sessionId={sessionId} source={source} entry={readme} />
      )}
    </div>
  );
}

/** A folder's README, as plain text (not rendered as Markdown). Shares its cache with the file view. */
function ReadmeText({
  user,
  sessionId,
  source,
  entry,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  entry: GitTreeNode;
}): JSX.Element | null {
  const readme = useQuery({
    queryKey: [
      'git-file',
      user,
      sessionId,
      source.repoId,
      source.remote ?? '',
      source.branch,
      entry.path,
    ] as const,
    queryFn: ({ signal }) => gitFile({ user, sessionId, source, path: entry.path }, signal),
  });
  if (readme.isPending) return <p className="text-xs text-muted">Loading {entry.name}…</p>;
  if (readme.isError || readme.data.content !== 'text') return null;
  return (
    <section aria-label={entry.name} className="rounded-md border border-line bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold">{entry.name}</h2>
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-ink">
        {readme.data.text}
      </pre>
    </section>
  );
}

function FileView({
  user,
  sessionId,
  source,
  path,
  file,
  blame,
  isBlameOn,
  isBlameLoading,
  isBlameFailed,
  lines,
  tokens,
  onHistory,
}: {
  user: string;
  sessionId: string;
  source: GitSource;
  path: string;
  file: GitFile;
  blame: GitBlame | undefined;
  isBlameOn: boolean;
  isBlameLoading: boolean;
  isBlameFailed: boolean;
  lines: LineRange | undefined;
  tokens: HighlightedToken[][] | undefined;
  onHistory: () => void;
}): JSX.Element {
  const lineParams = lines === undefined ? {} : { lines: formatLineRange(lines) };
  const blameToggle = codeUrl(user, sessionId, source, {
    path,
    ...lineParams,
    ...(isBlameOn ? { blame: '0' } : {}),
  });

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm">
        <span className="min-w-0 truncate font-mono text-ink">{path}</span>
        <span className="text-xs text-muted">{file.size} bytes</span>
        <div className="ml-auto flex gap-2">
          <Link
            to={blameToggle}
            aria-pressed={isBlameOn}
            className="touch-target flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 hover:bg-hover"
          >
            <GitCommitHorizontal className="size-4" aria-hidden />
            Blame {isBlameOn ? 'on' : 'off'}
          </Link>
          <button
            type="button"
            className="touch-target flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 hover:bg-hover"
            onClick={onHistory}
          >
            <FolderOpen className="size-4" aria-hidden /> History of this file
          </button>
          <button
            type="button"
            title="Copy the path of this file"
            className="touch-target flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 hover:bg-hover"
            onClick={() => {
              void copyText(path);
            }}
          >
            <Copy className="size-4" aria-hidden /> Copy path
          </button>
        </div>
      </div>
      {file.content !== 'text' ? (
        <Notice>
          {file.content === 'binary'
            ? 'Binary file: its contents are not shown.'
            : `Too large to show (${file.size} bytes).`}
        </Notice>
      ) : (
        <>
          {isBlameFailed && (
            <p role="status" className="px-4 py-1 text-xs text-muted">
              Blame is not available for this file.
            </p>
          )}
          {isBlameLoading && <p className="px-4 py-1 text-xs text-muted">Loading blame…</p>}
          <CodeView
            label={`${path} at ${source.branch}`}
            rows={codeRows(file.text ?? '', blame)}
            highlight={lines}
            tokens={tokens}
            gutter={
              blame === undefined
                ? undefined
                : (row) => (
                    <BlameTag
                      row={row}
                      user={user}
                      sessionId={sessionId}
                      source={source}
                      path={path}
                    />
                  )
            }
          />
        </>
      )}
    </div>
  );
}

import type { GitGrepMatch, GitSource } from '@om/shared';
import { useQuery } from '@tanstack/react-query';
import type { JSX, SubmitEvent } from 'react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ExploreHeader } from '../components/explore-header.tsx';
import { Loading, Notice } from '../components/notice.tsx';
import { gitGrep } from '../lib/api.ts';
import { exploreLinks } from '../lib/explore-links.ts';
import { useSessionDetail, useSessionParams } from '../lib/session.ts';
import { refParams, refSourceFromParams } from '../lib/sources.ts';
import { codeUrl } from '../lib/urls.ts';
import { useWorkspace } from '../lib/workspace-context.ts';

/** The search as the URL holds it: what to find, how, and where. */
type SearchState = { q: string; isRegex: boolean; isMatchCase: boolean; folder: string };

function searchFrom(params: URLSearchParams): SearchState {
  return {
    q: params.get('q') ?? '',
    isRegex: params.get('regex') === '1',
    isMatchCase: params.get('case') === '1',
    folder: params.get('in') ?? '',
  };
}

/**
 * Search tab: the lines of one ref that contain a text (or match a regular expression), grouped by file, each
 * with its neighbours. A hit opens the Code tab at that line. Searches only text files.
 */
export function SearchPage(): JSX.Element {
  const [params] = useSearchParams();
  const source = refSourceFromParams(params);
  if (source === undefined) {
    return <Notice>This search link is incomplete. Open it from the Code tab.</Notice>;
  }
  return (
    <SearchResults
      key={`${source.repoId}/${source.remote ?? ''}/${source.branch}`}
      source={source}
      search={searchFrom(params)}
    />
  );
}

function SearchResults({
  source,
  search,
}: {
  source: GitSource;
  search: SearchState;
}): JSX.Element {
  const { user, sessionId } = useSessionParams();
  const session = useSessionDetail(user, sessionId);
  const [, setParams] = useSearchParams();
  const workspace = useWorkspace();
  const [draft, setDraft] = useState(search);
  const repo = session.data?.repos.find((r) => r.id === source.repoId);

  const results = useQuery({
    queryKey: [
      'git-grep',
      user,
      sessionId,
      source.repoId,
      source.remote ?? '',
      source.branch,
      search,
    ] as const,
    queryFn: ({ signal }) =>
      gitGrep(
        {
          user,
          sessionId,
          source,
          query: search.q,
          regex: search.isRegex,
          ignoreCase: !search.isMatchCase,
          context: 1,
          ...(search.folder === '' ? {} : { paths: [search.folder] }),
        },
        signal,
      ),
    enabled: repo !== undefined && search.q !== '',
  });

  if (session.isError) return <Notice tone="error">{session.error.message}</Notice>;
  if (session.isPending) return <Loading label="Loading session…" />;
  if (repo === undefined) return <Notice>This repository is no longer in the session.</Notice>;

  const remote = source.remote ?? repo.remotes[0]?.name ?? 'origin';
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = refParams(source);
    if (draft.q.trim() !== '') next.set('q', draft.q.trim());
    if (draft.isRegex) next.set('regex', '1');
    if (draft.isMatchCase) next.set('case', '1');
    if (draft.folder.trim() !== '') next.set('in', draft.folder.trim().replace(/^\/+|\/+$/g, ''));
    setParams(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ExploreHeader
        where={`${repo.name} · ${remote} · ${source.branch}`}
        links={exploreLinks(user, sessionId, source, 'search')}
        onOpen={(url) => {
          workspace.open(url);
        }}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <form role="search" onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
            <span className="text-muted">Search for</span>
            <input
              type="search"
              value={draft.q}
              onChange={(event) => {
                setDraft({ ...draft, q: event.currentTarget.value });
              }}
              className="rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm"
              aria-label="Search query"
            />
          </label>
          <label className="flex min-w-40 flex-col gap-1 text-sm">
            <span className="text-muted">Only in folder</span>
            <input
              type="text"
              value={draft.folder}
              placeholder="all folders"
              onChange={(event) => {
                setDraft({ ...draft, folder: event.currentTarget.value });
              }}
              className="rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm"
              aria-label="Only in folder"
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={draft.isRegex}
              onChange={(event) => {
                setDraft({ ...draft, isRegex: event.currentTarget.checked });
              }}
            />
            Regular expression
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={draft.isMatchCase}
              onChange={(event) => {
                setDraft({ ...draft, isMatchCase: event.currentTarget.checked });
              }}
            />
            Match case
          </label>
          <button
            type="submit"
            className="touch-target rounded-md border border-line bg-accent-soft px-3 py-1.5 text-sm font-medium hover:bg-hover"
          >
            Search
          </button>
        </form>

        {search.q === '' && (
          <p className="text-sm text-muted">Type a search to look through this ref.</p>
        )}
        {results.isError && <Notice tone="error">{results.error.message}</Notice>}
        {search.q !== '' && !results.data && !results.isError && <Loading label="Searching…" />}
        {results.data && (
          <Matches
            data={results.data.matches}
            isTruncated={results.data.truncated}
            onOpen={(match) => {
              workspace.open(
                codeUrl(user, sessionId, source, { path: match.path, lines: String(match.line) }),
              );
            }}
          />
        )}
        {results.data?.matches.length === 0 && (
          <Notice>{`Nothing in ${source.branch} matches “${search.q}”.`}</Notice>
        )}
      </div>
    </div>
  );
}

/** The lines a search found, grouped by file, each with its neighbours. A line opens the Code tab at it. */
function Matches({
  data,
  isTruncated,
  onOpen,
}: {
  data: GitGrepMatch[];
  isTruncated: boolean;
  onOpen: (match: GitGrepMatch) => void;
}): JSX.Element {
  const files = [...new Set(data.map((m) => m.path))];
  return (
    <section aria-label="Search results" className="space-y-4">
      <p className="text-xs text-muted">
        {data.length} {data.length === 1 ? 'match' : 'matches'} in {files.length}{' '}
        {files.length === 1 ? 'file' : 'files'}
        {isTruncated ? ' · showing the first 1,000' : ''}
      </p>
      {files.map((file) => (
        <div key={file} className="rounded-md border border-line bg-surface">
          <h2 className="truncate border-b border-line px-3 py-1.5 font-mono text-xs text-ink">
            {file}
          </h2>
          <ul className="divide-y divide-line font-mono text-[13px]">
            {data
              .filter((m) => m.path === file)
              .map((match) => (
                <li key={`${match.path}:${match.line}:${match.column}`} className="px-3 py-1">
                  {match.before.map((line) => (
                    <div key={line.line} className="text-muted">
                      <span className="mr-3 inline-block w-8 text-right">{line.line}</span>
                      {line.text}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="block w-full truncate text-left text-ink hover:bg-hover"
                    onClick={() => {
                      onOpen(match);
                    }}
                  >
                    <span className="mr-3 inline-block w-8 text-right text-muted">
                      {match.line}
                    </span>
                    {match.text}
                  </button>
                  {match.after.map((line) => (
                    <div key={line.line} className="text-muted">
                      <span className="mr-3 inline-block w-8 text-right">{line.line}</span>
                      {line.text}
                    </div>
                  ))}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

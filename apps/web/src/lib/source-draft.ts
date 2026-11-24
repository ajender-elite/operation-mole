import { DEFAULT_REMOTE, type GitSource } from '@om/shared';

/**
 * A side being edited: like GitSource, but the repo and branch may still be empty. `remote` is the remote the
 * branch is on (origin when absent, as in GitSource).
 */
export type SourceDraft = {
  type: 'git';
  repoId: string;
  remote?: string | undefined;
  branch: string;
};

/** A blank side: the starting point of a new comparison form. */
export const emptyDraft: SourceDraft = { type: 'git', repoId: '', branch: '' };

/** Whether a draft names both a repository and a branch. */
export const isComplete = (d: SourceDraft): boolean => d.repoId !== '' && d.branch !== '';

/** The API source for a draft. Origin is left out, as GitSource treats a missing remote as origin. */
export const toSource = (d: SourceDraft): GitSource => ({
  type: 'git',
  repoId: d.repoId,
  branch: d.branch,
  ...(d.remote === undefined || d.remote === DEFAULT_REMOTE ? {} : { remote: d.remote }),
});

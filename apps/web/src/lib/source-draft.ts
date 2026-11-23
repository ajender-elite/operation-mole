import type { GitSource } from '@om/shared';

/** A side being edited: like GitSource, but the repo and branch may still be empty. */
export type SourceDraft = { type: 'git'; repoId: string; branch: string };

/** A blank side: the starting point of a new comparison form. */
export const emptyDraft: SourceDraft = { type: 'git', repoId: '', branch: '' };

/** Whether a draft names both a repository and a branch. */
export const isComplete = (d: SourceDraft): boolean => d.repoId !== '' && d.branch !== '';

/** The API source for a complete draft. */
export const toSource = (d: SourceDraft): GitSource => d;

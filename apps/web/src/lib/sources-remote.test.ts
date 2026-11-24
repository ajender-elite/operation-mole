import type { GitSource } from '@om/shared';
import { describe, expect, it } from 'vitest';
import { sourceFromParams, sourcesSearch } from './sources.ts';
import { toSource, type SourceDraft } from './source-draft.ts';

const ORIGIN: GitSource = { type: 'git', repoId: 'r1', branch: 'main' };
const UPSTREAM: GitSource = { type: 'git', repoId: 'r1', branch: 'release', remote: 'upstream' };

describe('the remote of a side', () => {
  it('is written to the URL only when it is not origin, and read back', () => {
    const search = new URLSearchParams(sourcesSearch(UPSTREAM, ORIGIN));
    expect(search.get('leftRemote')).toBe('upstream');
    expect(search.has('rightRemote')).toBe(false);
    expect(sourceFromParams(search, 'left')).toEqual(UPSTREAM);
    expect(sourceFromParams(search, 'right')).toEqual(ORIGIN);
  });

  it('is origin, and left out of the source, when the draft names origin', () => {
    const draft: SourceDraft = { type: 'git', repoId: 'r1', branch: 'main', remote: 'origin' };
    expect(toSource(draft)).toEqual(ORIGIN);
    expect(toSource({ ...draft, remote: 'upstream', branch: 'release' })).toEqual(UPSTREAM);
  });
});
